import { useCallback, useEffect, useRef, useState } from "react";

export type MidiConnectionStatus =
  | "not_connected"
  | "connected"
  | "disconnected"
  | "not_supported"
  | "permission_denied";

export interface MidiInputDeviceInfo {
  id: string;
  name: string;
  manufacturer?: string;
}

export interface WebMidiMessageEvent {
  data: Uint8Array;
  timeStamp?: number;
}

export interface WebMidiInputPort {
  id: string;
  name?: string | null;
  manufacturer?: string | null;
  state?: "connected" | "disconnected";
  onmidimessage: ((event: WebMidiMessageEvent) => void) | null;
}

export interface WebMidiAccess {
  inputs: Map<string, WebMidiInputPort> | Iterable<[string, WebMidiInputPort]>;
  onstatechange: ((event: { port?: WebMidiInputPort }) => void) | null;
}

export interface UseWebMidiOptions {
  onNoteOn?: (pitchMidi: number, velocity: number, timeStampMs?: number) => void;
  onNoteOff?: (pitchMidi: number, timeStampMs?: number) => void;
}

export function useWebMidi({ onNoteOn, onNoteOff }: UseWebMidiOptions) {
  const isSupported =
    typeof navigator !== "undefined" &&
    typeof (navigator as unknown as { requestMIDIAccess?: unknown }).requestMIDIAccess === "function";

  const [status, setStatus] = useState<MidiConnectionStatus>(() =>
    isSupported ? "not_connected" : "not_supported",
  );
  const [devices, setDevices] = useState<MidiInputDeviceInfo[]>([]);
  const [selectedDeviceId, setSelectedDeviceId] = useState<string>("");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const accessRef = useRef<WebMidiAccess | null>(null);
  const activePortRef = useRef<WebMidiInputPort | null>(null);
  const onNoteOnRef = useRef(onNoteOn);
  const onNoteOffRef = useRef(onNoteOff);
  onNoteOnRef.current = onNoteOn;
  onNoteOffRef.current = onNoteOff;

  const detachActivePort = useCallback(() => {
    if (activePortRef.current) {
      activePortRef.current.onmidimessage = null;
      activePortRef.current = null;
    }
  }, []);

  const readInputs = useCallback((access: WebMidiAccess): WebMidiInputPort[] => {
    const raw = access.inputs;
    if (raw instanceof Map) {
      return Array.from(raw.values());
    }
    return Array.from(raw).map(([, port]) => port);
  }, []);

  const syncDevices = useCallback(
    (access: WebMidiAccess, preferredId?: string) => {
      const ports = readInputs(access).filter((p) => p.state !== "disconnected");
      const list: MidiInputDeviceInfo[] = ports.map((p, idx) => ({
        id: p.id,
        name: (p.name || "").trim() || `MIDI Device ${idx + 1}`,
        manufacturer: p.manufacturer || undefined,
      }));
      setDevices(list);

      if (list.length === 0) {
        detachActivePort();
        setSelectedDeviceId("");
        setStatus((prev) => (prev === "not_connected" ? "not_connected" : "disconnected"));
        return;
      }

      const targetId =
        preferredId && list.some((d) => d.id === preferredId)
          ? preferredId
          : list[0].id;
      setSelectedDeviceId(targetId);
      setStatus("connected");
      setErrorMessage(null);
    },
    [detachActivePort, readInputs],
  );

  // Attach listener strictly to the currently selected MIDI input port
  useEffect(() => {
    const access = accessRef.current;
    if (!access || !selectedDeviceId) {
      detachActivePort();
      return;
    }

    const ports = readInputs(access);
    const port = ports.find((p) => p.id === selectedDeviceId && p.state !== "disconnected") || null;
    if (!port) {
      detachActivePort();
      return;
    }

    detachActivePort();
    port.onmidimessage = (event: WebMidiMessageEvent) => {
      const data = event.data;
      if (!data || data.length < 2) return;
      const command = data[0] & 0xf0;
      const pitch = data[1];
      const velocity = data.length >= 3 ? data[2] : 0;

      if (command === 0x90 && velocity > 0) {
        onNoteOnRef.current?.(pitch, velocity, event.timeStamp);
      } else if (command === 0x80 || (command === 0x90 && velocity === 0)) {
        onNoteOffRef.current?.(pitch, event.timeStamp);
      }
    };
    activePortRef.current = port;

    return () => {
      if (activePortRef.current === port) {
        port.onmidimessage = null;
        activePortRef.current = null;
      }
    };
  }, [selectedDeviceId, devices, detachActivePort, readInputs]);

  // Clean up on unmount
  useEffect(() => {
    return () => {
      detachActivePort();
      if (accessRef.current) {
        accessRef.current.onstatechange = null;
        accessRef.current = null;
      }
    };
  }, [detachActivePort]);

  const connect = useCallback(async () => {
    if (!isSupported) {
      setStatus("not_supported");
      setErrorMessage("Web MIDI API is not supported in this browser.");
      return;
    }
    try {
      setErrorMessage(null);
      const req = (navigator as unknown as {
        requestMIDIAccess: (opts?: { sysex?: boolean }) => Promise<WebMidiAccess>;
      }).requestMIDIAccess;
      const access = await req.call(navigator, { sysex: false });
      accessRef.current = access;
      access.onstatechange = () => {
        syncDevices(access, selectedDeviceId);
      };
      syncDevices(access, selectedDeviceId);
    } catch (err) {
      detachActivePort();
      setDevices([]);
      setSelectedDeviceId("");
      setStatus("permission_denied");
      setErrorMessage(err instanceof Error ? err.message : "MIDI access permission was denied.");
    }
  }, [isSupported, selectedDeviceId, syncDevices, detachActivePort]);

  const disconnect = useCallback(() => {
    detachActivePort();
    if (accessRef.current) {
      accessRef.current.onstatechange = null;
      accessRef.current = null;
    }
    setDevices([]);
    setSelectedDeviceId("");
    setStatus(isSupported ? "not_connected" : "not_supported");
  }, [detachActivePort, isSupported]);

  const selectedDevice = devices.find((d) => d.id === selectedDeviceId) || null;

  return {
    isSupported,
    status,
    devices,
    selectedDeviceId,
    selectedDeviceName: selectedDevice?.name || null,
    setSelectedDeviceId,
    errorMessage,
    connect,
    disconnect,
  };
}

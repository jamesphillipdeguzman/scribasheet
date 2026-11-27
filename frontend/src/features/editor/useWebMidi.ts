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
  connection?: "open" | "closed" | "pending";
  onmidimessage: ((event: WebMidiMessageEvent) => void) | null;
  open?: () => Promise<WebMidiInputPort | void> | void;
  close?: () => Promise<WebMidiInputPort | void> | void;
}

export interface WebMidiAccess {
  inputs: Map<string, WebMidiInputPort> | Iterable<[string, WebMidiInputPort]>;
  onstatechange: ((event: { port?: WebMidiInputPort }) => void) | null;
}

const MIDI_MONITOR_STORAGE_KEY = "scribasheet_midi_monitor_enabled";

export function loadMidiMonitorPreference(): boolean {
  if (typeof window === "undefined" || typeof window.localStorage?.getItem !== "function") {
    return true;
  }
  try {
    const raw = window.localStorage.getItem(MIDI_MONITOR_STORAGE_KEY);
    if (raw === "false") return false;
    if (raw === "true") return true;
    return true;
  } catch {
    return true;
  }
}

export function saveMidiMonitorPreference(enabled: boolean): void {
  if (typeof window === "undefined" || typeof window.localStorage?.setItem !== "function") {
    return;
  }
  try {
    window.localStorage.setItem(MIDI_MONITOR_STORAGE_KEY, enabled ? "true" : "false");
  } catch {
    // Ignore storage quota or private-mode errors
  }
}

export interface UseWebMidiOptions {
  onNoteOn?: (pitchMidi: number, velocity: number, timeStampMs?: number) => void;
  onNoteOff?: (pitchMidi: number, timeStampMs?: number) => void;
  onControlChange?: (controller: number, value: number, timeStampMs?: number) => void;
  onDisconnect?: () => void;
}

export function useWebMidi({
  onNoteOn,
  onNoteOff,
  onControlChange,
  onDisconnect,
}: UseWebMidiOptions = {}) {
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
  const isConnectedRef = useRef(false);
  const connectGenRef = useRef(0);
  const selectedDeviceIdRef = useRef(selectedDeviceId);
  const onNoteOnRef = useRef(onNoteOn);
  const onNoteOffRef = useRef(onNoteOff);
  const onControlChangeRef = useRef(onControlChange);
  const onDisconnectRef = useRef(onDisconnect);
  selectedDeviceIdRef.current = selectedDeviceId;
  onNoteOnRef.current = onNoteOn;
  onNoteOffRef.current = onNoteOff;
  onControlChangeRef.current = onControlChange;
  onDisconnectRef.current = onDisconnect;

  const readInputs = useCallback((access: WebMidiAccess): WebMidiInputPort[] => {
    const raw = access.inputs;
    if (raw instanceof Map) {
      return Array.from(raw.values());
    }
    if (typeof (raw as { values?: () => Iterable<WebMidiInputPort> }).values === "function") {
      return Array.from((raw as Map<string, WebMidiInputPort>).values());
    }
    return Array.from(raw).map(([, port]) => port);
  }, []);

  const closePortSafely = useCallback((port: WebMidiInputPort | null | undefined) => {
    if (!port) return;
    port.onmidimessage = null;
    if (typeof port.close === "function") {
      try {
        void Promise.resolve(port.close()).catch(() => {});
      } catch {
        // Ignore close errors in mocked or restricted environments
      }
    }
  }, []);

  const detachActivePort = useCallback(() => {
    if (activePortRef.current) {
      closePortSafely(activePortRef.current);
      activePortRef.current = null;
    }
  }, [closePortSafely]);

  const unbindAndCloseAllInputs = useCallback(
    (access: WebMidiAccess | null | undefined) => {
      const closedPorts = new Set<WebMidiInputPort>();
      if (activePortRef.current) {
        closedPorts.add(activePortRef.current);
        closePortSafely(activePortRef.current);
        activePortRef.current = null;
      }
      if (!access) return;
      for (const port of readInputs(access)) {
        if (closedPorts.has(port)) continue;
        closedPorts.add(port);
        closePortSafely(port);
      }
    },
    [closePortSafely, readInputs],
  );

  const syncDevices = useCallback(
    (access: WebMidiAccess, preferredId?: string) => {
      if (!isConnectedRef.current) return;
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
    if (!access || !selectedDeviceId || !isConnectedRef.current) {
      detachActivePort();
      return;
    }

    const ports = readInputs(access);
    const port = ports.find((p) => p.id === selectedDeviceId && p.state !== "disconnected") || null;
    if (!port) {
      detachActivePort();
      return;
    }

    for (const p of ports) {
      if (p !== port) {
        p.onmidimessage = null;
      }
    }
    if (activePortRef.current && activePortRef.current !== port) {
      detachActivePort();
    }

    if (typeof port.open === "function" && port.connection !== "open") {
      try {
        void Promise.resolve(port.open()).catch(() => {});
      } catch {
        // Ignore open errors in mocked or restricted environments
      }
    }

    port.onmidimessage = (event: WebMidiMessageEvent) => {
      if (!isConnectedRef.current || activePortRef.current !== port) return;
      const data = event.data;
      if (!data || data.length < 2) return;
      const command = data[0] & 0xf0;
      const param1 = data[1];
      const param2 = data.length >= 3 ? data[2] : 0;

      if (command === 0x90 && param2 > 0) {
        onNoteOnRef.current?.(param1, param2, event.timeStamp);
      } else if (command === 0x80 || (command === 0x90 && param2 === 0)) {
        onNoteOffRef.current?.(param1, event.timeStamp);
      } else if (command === 0xb0) {
        onControlChangeRef.current?.(param1, param2, event.timeStamp);
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

  // Clean up and close all MIDI input ports on unmount
  useEffect(() => {
    return () => {
      connectGenRef.current += 1;
      isConnectedRef.current = false;
      const access = accessRef.current;
      if (access) {
        access.onstatechange = null;
        unbindAndCloseAllInputs(access);
        accessRef.current = null;
      } else {
        detachActivePort();
      }
      onDisconnectRef.current?.();
    };
  }, [detachActivePort, unbindAndCloseAllInputs]);

  const connect = useCallback(async () => {
    if (!isSupported) {
      setStatus("not_supported");
      setErrorMessage("Web MIDI API is not supported in this browser.");
      return;
    }
    const gen = ++connectGenRef.current;
    isConnectedRef.current = true;
    if (accessRef.current) {
      accessRef.current.onstatechange = null;
      unbindAndCloseAllInputs(accessRef.current);
      accessRef.current = null;
    }

    try {
      setErrorMessage(null);
      const req = (navigator as unknown as {
        requestMIDIAccess: (opts?: { sysex?: boolean }) => Promise<WebMidiAccess>;
      }).requestMIDIAccess;
      const access = await req.call(navigator, { sysex: false });
      if (connectGenRef.current !== gen || !isConnectedRef.current) {
        access.onstatechange = null;
        unbindAndCloseAllInputs(access);
        return;
      }
      accessRef.current = access;
      access.onstatechange = () => {
        if (!isConnectedRef.current || accessRef.current !== access) return;
        syncDevices(access, selectedDeviceIdRef.current);
      };
      syncDevices(access, selectedDeviceIdRef.current);
    } catch (err) {
      if (connectGenRef.current !== gen || !isConnectedRef.current) {
        return;
      }
      isConnectedRef.current = false;
      detachActivePort();
      setDevices([]);
      setSelectedDeviceId("");
      setStatus("permission_denied");
      setErrorMessage(err instanceof Error ? err.message : "MIDI access permission was denied.");
    }
  }, [isSupported, syncDevices, detachActivePort, unbindAndCloseAllInputs]);

  const disconnect = useCallback(() => {
    connectGenRef.current += 1;
    isConnectedRef.current = false;
    const access = accessRef.current;
    if (access) {
      access.onstatechange = null;
      unbindAndCloseAllInputs(access);
      accessRef.current = null;
    } else {
      detachActivePort();
    }
    onDisconnectRef.current?.();
    setDevices([]);
    setSelectedDeviceId("");
    setErrorMessage(null);
    setStatus(isSupported ? "not_connected" : "not_supported");
  }, [detachActivePort, isSupported, unbindAndCloseAllInputs]);

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

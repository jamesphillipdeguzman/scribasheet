import { useState } from "react";
import { Link } from "react-router-dom";
import {
  ArrowRight,
  AudioWaveform,
  Check,
  ChevronDown,
  Download,
  FileMusic,
  Guitar,
  Layers,
  Menu,
  Mic,
  Piano,
  Play,
  Sliders,
  Sparkles,
  Upload,
  X,
} from "lucide-react";
import { BrandMark } from "@/components/BrandMark";
import { Button } from "@/components/ui/Button";
import { useAuth } from "@/features/auth/AuthContext";

const INSTRUMENTS = [
  "Piano",
  "Acoustic Guitar",
  "Electric Guitar",
  "Bass Guitar",
  "Violin",
  "Viola",
  "Cello",
  "Double Bass",
  "Flute",
  "Clarinet",
  "Saxophone",
  "Trumpet",
  "Trombone",
  "Drums & Percussion",
  "Vocals",
];

const FAQS = [
  {
    q: "How does ScribaSheet transcribe audio into sheet music?",
    a: "ScribaSheet normalizes your uploaded or recorded audio using FFmpeg and Librosa, runs Spotify's Basic Pitch neural network to detect polyphonic pitch onsets and offsets, analyzes tempo, key, and chords, and generates structured MusicXML and MIDI using Music21.",
  },
  {
    q: "What instruments and audio formats work best?",
    a: "Solo instrument recordings (piano, guitar, vocals, strings, winds) in WAV, FLAC, MP3, M4A, or AAC produce the cleanest transcriptions. Full-band multi-instrument mixes are supported experimentally, and we clearly indicate when automatic detection is an estimate.",
  },
  {
    q: "Can I edit the transcribed notes before exporting?",
    a: "Yes. Every transcription opens in the interactive ScribaSheet Studio with an OpenSheetMusicDisplay notation viewer, a synchronized Piano Roll editor, Chord analysis, and Guitar Tablature. All edits update the underlying MIDI and MusicXML.",
  },
  {
    q: "Are my uploaded recordings kept private?",
    a: "Yes. All uploaded audio, stems, scores, and exports are stored privately and scoped strictly to your authenticated account with signed download URLs and ownership checks on every API endpoint.",
  },
];

export function LandingPage() {
  const { user } = useAuth();
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [openFaq, setOpenFaq] = useState<number | null>(0);

  return (
    <div className="min-h-screen bg-[#09090F] text-[#F5F3FF]">
      {/* Header */}
      <header className="sticky top-0 z-40 border-b border-[#27273A]/80 bg-[#09090F]/85 backdrop-blur-md">
        <div className="mx-auto flex h-16 max-w-7xl items-center justify-between px-4 sm:px-6">
          <Link to="/" aria-label="ScribaSheet Home">
            <BrandMark />
          </Link>

          <nav className="hidden md:flex items-center gap-7 text-sm text-[#A1A1AA]" aria-label="Primary">
            <a href="#features" className="hover:text-[#F5F3FF] transition-colors">
              Features
            </a>
            <a href="#how-it-works" className="hover:text-[#F5F3FF] transition-colors">
              How It Works
            </a>
            <a href="#instruments" className="hover:text-[#F5F3FF] transition-colors">
              Supported Instruments
            </a>
            <a href="#pricing" className="hover:text-[#F5F3FF] transition-colors">
              Pricing
            </a>
          </nav>

          <div className="hidden md:flex items-center gap-3">
            {user ? (
              <Link to="/dashboard">
                <Button size="sm">Open Studio Dashboard</Button>
              </Link>
            ) : (
              <>
                <Link to="/login">
                  <Button variant="ghost" size="sm">
                    Sign In
                  </Button>
                </Link>
                <Link to="/register">
                  <Button size="sm">
                    Get Started
                    <ArrowRight className="h-4 w-4" />
                  </Button>
                </Link>
              </>
            )}
          </div>

          <button
            type="button"
            className="md:hidden rounded-lg p-2 text-[#A1A1AA] hover:bg-[#181825] hover:text-[#F5F3FF]"
            onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
            aria-label="Toggle navigation menu"
          >
            {mobileMenuOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
          </button>
        </div>

        {mobileMenuOpen && (
          <div className="md:hidden border-t border-[#27273A] bg-[#11111B] px-4 py-4 space-y-3">
            <a href="#features" onClick={() => setMobileMenuOpen(false)} className="block text-sm text-[#A1A1AA] hover:text-[#F5F3FF]">
              Features
            </a>
            <a href="#how-it-works" onClick={() => setMobileMenuOpen(false)} className="block text-sm text-[#A1A1AA] hover:text-[#F5F3FF]">
              How It Works
            </a>
            <a href="#instruments" onClick={() => setMobileMenuOpen(false)} className="block text-sm text-[#A1A1AA] hover:text-[#F5F3FF]">
              Supported Instruments
            </a>
            <a href="#pricing" onClick={() => setMobileMenuOpen(false)} className="block text-sm text-[#A1A1AA] hover:text-[#F5F3FF]">
              Pricing
            </a>
            <div className="pt-2 flex gap-2">
              <Link to="/login" className="flex-1">
                <Button variant="outline" className="w-full" size="sm">
                  Sign In
                </Button>
              </Link>
              <Link to="/register" className="flex-1">
                <Button className="w-full" size="sm">
                  Get Started
                </Button>
              </Link>
            </div>
          </div>
        )}
      </header>

      {/* Hero Section */}
      <section className="relative overflow-hidden border-b border-[#27273A]/60 py-16 sm:py-24">
        <div className="mx-auto max-w-7xl px-4 sm:px-6">
          <div className="mx-auto max-w-3xl text-center">
            <div className="mb-5 inline-flex items-center gap-2 rounded-full border border-[#A78BFA]/30 bg-[#181825] px-3.5 py-1 text-xs font-medium text-[#A78BFA]">
              <Sparkles className="h-3.5 w-3.5" />
              From Sound to Sheet Music
            </div>
            <h1 className="text-4xl font-bold tracking-tight text-[#F5F3FF] sm:text-6xl">
              Turn Any Performance Into Sheet Music.
            </h1>
            <p className="mt-6 text-base leading-relaxed text-[#A1A1AA] sm:text-lg">
              Transform audio recordings into editable musical notation with AI-powered transcription. Upload a song,
              review the notes, and bring your music to the page.
            </p>
            <div className="mt-8 flex flex-col sm:flex-row items-center justify-center gap-3.5">
              <Link to={user ? "/dashboard" : "/register"}>
                <Button size="lg" className="w-full sm:w-auto">
                  Start Transcribing
                  <ArrowRight className="h-4 w-4" />
                </Button>
              </Link>
              <a href="#how-it-works">
                <Button variant="outline" size="lg" className="w-full sm:w-auto">
                  See How It Works
                </Button>
              </a>
            </div>
          </div>

          {/* Authentic Studio Workspace Preview */}
          <div className="mt-14 rounded-2xl border border-[#27273A] bg-[#11111B] p-3 sm:p-5 shadow-2xl">
            <div className="flex items-center justify-between border-b border-[#27273A] pb-3 mb-4">
              <div className="flex items-center gap-3">
                <span className="text-xs font-mono uppercase tracking-wider text-[#A78BFA]">ScribaSheet Studio</span>
                <span className="hidden sm:inline text-xs text-[#A1A1AA]">• OpenSheetMusicDisplay + Piano Roll + WaveSurfer</span>
              </div>
              <div className="flex items-center gap-2 text-xs text-[#A1A1AA]">
                <span className="rounded bg-[#181825] px-2 py-0.5 border border-[#27273A]">120 BPM</span>
                <span className="rounded bg-[#181825] px-2 py-0.5 border border-[#27273A]">4/4</span>
                <span className="rounded bg-[#181825] px-2 py-0.5 border border-[#27273A]">C Major</span>
              </div>
            </div>
            <div className="grid gap-4 lg:grid-cols-3">
              <div className="lg:col-span-2 rounded-xl border border-[#27273A] bg-[#09090F] p-5">
                <div className="flex items-center justify-between mb-4">
                  <span className="text-xs font-medium text-[#A1A1AA]">Sheet Music Canvas (MusicXML)</span>
                  <span className="text-xs text-[#A78BFA]">Grand Staff • Treble & Bass</span>
                </div>
                {/* Clean SVG staff representation */}
                <svg viewBox="0 0 600 130" className="w-full h-32 text-[#F5F3FF]" aria-label="Musical staff preview">
                  {[20, 32, 44, 56, 68].map((y) => (
                    <line key={y} x1="20" y1={y} x2="580" y2={y} stroke="#27273A" strokeWidth="1.5" />
                  ))}
                  <line x1="20" y1="20" x2="20" y2="68" stroke="#A78BFA" strokeWidth="2" />
                  <line x1="300" y1="20" x2="300" y2="68" stroke="#27273A" strokeWidth="1.5" />
                  <line x1="580" y1="20" x2="580" y2="68" stroke="#A78BFA" strokeWidth="2" />
                  {[
                    { x: 85, y: 68 },
                    { x: 145, y: 56 },
                    { x: 205, y: 44 },
                    { x: 265, y: 32 },
                    { x: 350, y: 38 },
                    { x: 415, y: 50 },
                    { x: 480, y: 56 },
                    { x: 540, y: 68 },
                  ].map((n, idx) => (
                    <g key={idx}>
                      <ellipse cx={n.x} cy={n.y} rx="7" ry="5" fill="#A78BFA" transform={`rotate(-18 ${n.x} ${n.y})`} />
                      <line x1={n.x + 6} y1={n.y} x2={n.x + 6} y2={n.y - 28} stroke="#F5F3FF" strokeWidth="1.8" />
                    </g>
                  ))}
                </svg>
                <div className="mt-3 flex items-center gap-3 rounded-lg border border-[#27273A] bg-[#11111B] px-3 py-2">
                  <Play className="h-4 w-4 text-[#A78BFA]" />
                  <div className="flex-1 flex items-center gap-1 h-5">
                    {[18, 35, 65, 45, 80, 60, 40, 90, 75, 50, 30, 70, 85, 55, 40, 65, 50, 30, 60, 45].map((h, i) => (
                      <div key={i} className="flex-1 rounded-sm bg-[#8B5CF6]/60" style={{ height: `${h}%` }} />
                    ))}
                  </div>
                  <span className="text-xs font-mono text-[#A1A1AA]">A/B Audio • MIDI</span>
                </div>
              </div>
              <div className="rounded-xl border border-[#27273A] bg-[#09090F] p-5 flex flex-col justify-between">
                <div>
                  <span className="text-xs font-medium text-[#A1A1AA]">Pipeline & Export</span>
                  <ul className="mt-4 space-y-2.5 text-sm">
                    {[
                      "FFmpeg & Librosa normalization",
                      "Basic Pitch AI note detection",
                      "Music21 MusicXML engraving",
                      "Piano Roll & Tab editing",
                      "MIDI, MusicXML, PDF & WAV exports",
                    ].map((item) => (
                      <li key={item} className="flex items-center gap-2 text-[#F5F3FF]">
                        <Check className="h-4 w-4 text-emerald-400 shrink-0" />
                        <span>{item}</span>
                      </li>
                    ))}
                  </ul>
                </div>
                <div className="mt-6 pt-4 border-t border-[#27273A] text-xs text-[#A1A1AA]">
                  Real neural transcription — never mocked or hardcoded.
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* How It Works */}
      <section id="how-it-works" className="py-20 border-b border-[#27273A]/60">
        <div className="mx-auto max-w-7xl px-4 sm:px-6">
          <div className="max-w-2xl">
            <h2 className="text-2xl font-bold tracking-tight sm:text-3xl">How It Works</h2>
            <p className="mt-2 text-[#A1A1AA]">From raw recording to publication-ready notation in four transparent stages.</p>
          </div>
          <div className="mt-10 grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
            {[
              { icon: Upload, step: "01", title: "Upload or Record", desc: "Drop MP3, WAV, FLAC, M4A, AAC, MP4, MOV, or WEBM files, or record directly from your microphone." },
              { icon: Sliders, step: "02", title: "Configure Settings", desc: "Choose instrument, mode, tempo, key, quantization grid, and pitch range." },
              { icon: AudioWaveform, step: "03", title: "AI Transcription", desc: "Background workers normalize audio and run Spotify Basic Pitch + Music21 analysis." },
              { icon: Download, step: "04", title: "Edit & Export", desc: "Refine notes in the Piano Roll, compare with original audio, and export MIDI, MusicXML, PDF, or WAV." },
            ].map((s) => {
              const Icon = s.icon;
              return (
                <div key={s.step} className="rounded-xl border border-[#27273A] bg-[#11111B] p-6">
                  <div className="flex items-center justify-between">
                    <div className="rounded-lg bg-[#181825] p-2.5 border border-[#27273A]">
                      <Icon className="h-5 w-5 text-[#A78BFA]" />
                    </div>
                    <span className="font-mono text-xs text-[#A1A1AA]">{s.step}</span>
                  </div>
                  <h3 className="mt-4 font-semibold text-[#F5F3FF]">{s.title}</h3>
                  <p className="mt-2 text-sm text-[#A1A1AA] leading-relaxed">{s.desc}</p>
                </div>
              );
            })}
          </div>
        </div>
      </section>

      {/* Features & Interactive Editor */}
      <section id="features" className="py-20 border-b border-[#27273A]/60 bg-[#11111B]/40">
        <div className="mx-auto max-w-7xl px-4 sm:px-6">
          <div className="max-w-2xl">
            <h2 className="text-2xl font-bold tracking-tight sm:text-3xl">Transcription & Studio Features</h2>
            <p className="mt-2 text-[#A1A1AA]">Built for real musicians, students, composers, and arrangers.</p>
          </div>
          <div className="mt-10 grid gap-6 md:grid-cols-3">
            {[
              { icon: Piano, title: "Grand Staff & Clefs", desc: "Automatic treble, bass, and piano grand-staff engraving rendered live with OpenSheetMusicDisplay." },
              { icon: Layers, title: "Synchronized Piano Roll", desc: "Select, move, resize, add, or delete notes with grid snapping, velocity control, and full Undo/Redo." },
              { icon: Mic, title: "A/B Audio Comparison", desc: "Play back the original WaveSurfer waveform alongside our Web Audio MIDI synthesizer." },
              { icon: Guitar, title: "Chords & Guitar Tab", desc: "Automatic harmonic chord analysis plus standard-tuning guitar string/fret mapping and editing." },
              { icon: FileMusic, title: "Canonical Score Persistence", desc: "Every edit regenerates real MIDI and MusicXML on the server with debounced autosave." },
              { icon: Download, title: "Multi-Format Exports", desc: "Download standard .mid, .musicxml, printable .pdf sheet music, and synthesized .wav audio." },
            ].map((f) => {
              const Icon = f.icon;
              return (
                <div key={f.title} className="rounded-xl border border-[#27273A] bg-[#11111B] p-6">
                  <Icon className="h-5 w-5 text-[#A78BFA]" />
                  <h3 className="mt-3 font-semibold text-[#F5F3FF]">{f.title}</h3>
                  <p className="mt-2 text-sm text-[#A1A1AA] leading-relaxed">{f.desc}</p>
                </div>
              );
            })}
          </div>
        </div>
      </section>

      {/* Supported Instruments */}
      <section id="instruments" className="py-20 border-b border-[#27273A]/60">
        <div className="mx-auto max-w-7xl px-4 sm:px-6">
          <h2 className="text-2xl font-bold tracking-tight sm:text-3xl">Supported Instruments & Workflows</h2>
          <p className="mt-2 text-[#A1A1AA] max-w-2xl">
            Optimized for solo instrument and vocal recordings, with experimental support for polyphonic mixes.
          </p>
          <div className="mt-8 flex flex-wrap gap-2.5">
            {INSTRUMENTS.map((inst) => (
              <span
                key={inst}
                className="rounded-lg border border-[#27273A] bg-[#11111B] px-3.5 py-2 text-sm text-[#F5F3FF]"
              >
                {inst}
              </span>
            ))}
          </div>
        </div>
      </section>

      {/* Pricing */}
      <section id="pricing" className="py-20 border-b border-[#27273A]/60 bg-[#11111B]/40">
        <div className="mx-auto max-w-7xl px-4 sm:px-6">
          <div className="max-w-2xl">
            <h2 className="text-2xl font-bold tracking-tight sm:text-3xl">Plans Built to Scale</h2>
            <p className="mt-2 text-[#A1A1AA]">
              Start transcribing immediately on the Free plan. Pro and Studio tiers are configurable for commercial deployments.
            </p>
          </div>
          <div className="mt-10 grid gap-6 md:grid-cols-3">
            {[
              {
                name: "Free",
                badge: "Available Now",
                desc: "For students and hobbyists exploring AI transcription.",
                features: ["30 monthly transcription minutes", "Single-instrument, piano & vocal modes", "Interactive editor & playback", "MIDI & MusicXML exports"],
              },
              {
                name: "Pro",
                badge: "Configurable Tier",
                desc: "For active musicians, educators, and arrangers.",
                features: ["300 monthly transcription minutes", "PDF sheet music & WAV exports", "Chord analysis & guitar tablature", "Higher processing priority"],
              },
              {
                name: "Studio",
                badge: "Configurable Tier",
                desc: "For composers and multi-instrument production workflows.",
                features: ["1,500 monthly transcription minutes", "25 GB private media storage", "Multi-instrument & stem workflows", "Priority background workers"],
              },
            ].map((plan) => (
              <div key={plan.name} className="rounded-xl border border-[#27273A] bg-[#11111B] p-6 flex flex-col justify-between">
                <div>
                  <div className="flex items-center justify-between">
                    <h3 className="text-lg font-semibold">{plan.name}</h3>
                    <span className="rounded-full border border-[#A78BFA]/30 bg-[#181825] px-2.5 py-0.5 text-xs text-[#A78BFA]">
                      {plan.badge}
                    </span>
                  </div>
                  <p className="mt-2 text-sm text-[#A1A1AA]">{plan.desc}</p>
                  <ul className="mt-5 space-y-2.5 text-sm">
                    {plan.features.map((feat) => (
                      <li key={feat} className="flex items-center gap-2">
                        <Check className="h-4 w-4 text-[#A78BFA] shrink-0" />
                        <span>{feat}</span>
                      </li>
                    ))}
                  </ul>
                </div>
                <Link to="/register" className="mt-6 block">
                  <Button variant={plan.name === "Free" ? "primary" : "outline"} className="w-full">
                    Get Started with {plan.name}
                  </Button>
                </Link>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* FAQ */}
      <section className="py-20 border-b border-[#27273A]/60">
        <div className="mx-auto max-w-3xl px-4 sm:px-6">
          <h2 className="text-2xl font-bold tracking-tight sm:text-3xl text-center">Frequently Asked Questions</h2>
          <div className="mt-8 space-y-3">
            {FAQS.map((item, idx) => {
              const isOpen = openFaq === idx;
              return (
                <div key={item.q} className="rounded-xl border border-[#27273A] bg-[#11111B] overflow-hidden">
                  <button
                    type="button"
                    className="flex w-full items-center justify-between px-5 py-4 text-left font-medium text-[#F5F3FF] hover:bg-[#181825]/60"
                    onClick={() => setOpenFaq(isOpen ? null : idx)}
                    aria-expanded={isOpen}
                  >
                    <span>{item.q}</span>
                    <ChevronDown className={`h-4 w-4 text-[#A78BFA] transition-transform ${isOpen ? "rotate-180" : ""}`} />
                  </button>
                  {isOpen && <div className="px-5 pb-4 text-sm text-[#A1A1AA] leading-relaxed">{item.a}</div>}
                </div>
              );
            })}
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="py-10 bg-[#09090F]">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 flex flex-col sm:flex-row items-center justify-between gap-4">
          <BrandMark size="sm" />
          <p className="text-xs text-[#A1A1AA]">ScribaSheet — AI-Powered Music Transcription Studio. From Sound to Sheet Music.</p>
          <div className="flex items-center gap-4 text-xs text-[#A1A1AA]">
            <Link to="/login" className="hover:text-[#F5F3FF]">Sign In</Link>
            <Link to="/register" className="hover:text-[#F5F3FF]">Create Account</Link>
          </div>
        </div>
      </footer>
    </div>
  );
}

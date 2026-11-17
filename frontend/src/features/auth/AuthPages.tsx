import { useEffect, useRef, useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Link, useNavigate } from "react-router-dom";
import { BrandMark } from "@/components/BrandMark";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { useAuth } from "@/features/auth/AuthContext";
import { api, ApiError } from "@/services/api";

const loginSchema = z.object({
  email: z.string().email("Enter a valid email address"),
  password: z.string().min(1, "Password is required"),
});

const registerSchema = z.object({
  displayName: z.string().min(1, "Display name is required").max(120),
  email: z.string().email("Enter a valid email address"),
  password: z.string().min(8, "Password must be at least 8 characters"),
});

function AuthLayout({ title, subtitle, children }: { title: string; subtitle: string; children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-[#09090F] flex flex-col items-center justify-center px-4 py-12">
      <Link to="/" className="mb-8" aria-label="Back to ScribaSheet home">
        <BrandMark size="lg" />
      </Link>
      <div className="w-full max-w-md rounded-2xl border border-[#27273A] bg-[#11111B] p-7 shadow-xl">
        <h1 className="text-xl font-bold text-[#F5F3FF]">{title}</h1>
        <p className="mt-1 text-sm text-[#A1A1AA]">{subtitle}</p>
        <div className="mt-6">{children}</div>
      </div>
    </div>
  );
}

export function LoginPage() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const [serverError, setServerError] = useState<string | null>(null);
  const [wakingUp, setWakingUp] = useState(false);
  const loginInFlightRef = useRef(false);

  useEffect(() => {
    void api.wakeUpBackend();
  }, []);
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<z.infer<typeof loginSchema>>({ resolver: zodResolver(loginSchema) });

  const onSubmit = async (values: z.infer<typeof loginSchema>) => {
    if (loginInFlightRef.current) return;
    loginInFlightRef.current = true;
    setServerError(null);
    const wakeTimer = window.setTimeout(() => setWakingUp(true), 1500);
    try {
      await login(values.email, values.password);
      navigate("/dashboard");
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") {
        return;
      }
      setServerError(err instanceof ApiError ? err.message : "Failed to sign in.");
    } finally {
      clearTimeout(wakeTimer);
      setWakingUp(false);
      loginInFlightRef.current = false;
    }
  };

  return (
    <AuthLayout title="Sign in to ScribaSheet" subtitle="Access your transcription projects and studio.">
      <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
        {serverError && (
          <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300" role="alert">
            {serverError}
          </div>
        )}
        <Input label="Email" type="email" placeholder="you@example.com" {...register("email")} error={errors.email?.message} />
        <Input label="Password" type="password" placeholder="••••••••" {...register("password")} error={errors.password?.message} />
        <div className="flex justify-end">
          <Link to="/forgot-password" className="text-xs text-[#A78BFA] hover:underline">
            Forgot password?
          </Link>
        </div>
        <Button type="submit" className="w-full" disabled={isSubmitting}>
          {isSubmitting ? (wakingUp ? "Waking up server..." : "Signing in...") : "Sign In"}
        </Button>
      </form>
      <p className="mt-5 text-center text-xs text-[#A1A1AA]">
        Don&apos;t have an account?{" "}
        <Link to="/register" className="text-[#A78BFA] hover:underline font-medium">
          Create one
        </Link>
      </p>
    </AuthLayout>
  );
}

export function RegisterPage() {
  const { register: registerUser } = useAuth();
  const navigate = useNavigate();
  const [serverError, setServerError] = useState<string | null>(null);
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<z.infer<typeof registerSchema>>({ resolver: zodResolver(registerSchema) });

  const onSubmit = async (values: z.infer<typeof registerSchema>) => {
    setServerError(null);
    try {
      await registerUser(values.email, values.password, values.displayName);
      navigate("/dashboard");
    } catch (err) {
      setServerError(err instanceof ApiError ? err.message : "Failed to create account.");
    }
  };

  return (
    <AuthLayout title="Create your ScribaSheet account" subtitle="Start turning audio performances into editable sheet music.">
      <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
        {serverError && (
          <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300" role="alert">
            {serverError}
          </div>
        )}
        <Input label="Display Name" placeholder="Clara Schumann" {...register("displayName")} error={errors.displayName?.message} />
        <Input label="Email" type="email" placeholder="you@example.com" {...register("email")} error={errors.email?.message} />
        <Input label="Password" type="password" placeholder="At least 8 characters" {...register("password")} error={errors.password?.message} />
        <Button type="submit" className="w-full" disabled={isSubmitting}>
          {isSubmitting ? "Creating account..." : "Create Account"}
        </Button>
      </form>
      <p className="mt-5 text-center text-xs text-[#A1A1AA]">
        Already have an account?{" "}
        <Link to="/login" className="text-[#A78BFA] hover:underline font-medium">
          Sign in
        </Link>
      </p>
    </AuthLayout>
  );
}

export function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    try {
      const res = await api.forgotPassword(email);
      setMessage(res.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <AuthLayout title="Reset your password" subtitle="Enter your account email to request a password reset.">
      <form onSubmit={handleSubmit} className="space-y-4">
        {message && (
          <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-300">
            {message}
          </div>
        )}
        <Input label="Email" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" />
        <Button type="submit" className="w-full" disabled={loading}>
          {loading ? "Sending..." : "Send Reset Instructions"}
        </Button>
      </form>
      <p className="mt-5 text-center text-xs text-[#A1A1AA]">
        <Link to="/login" className="text-[#A78BFA] hover:underline">
          Back to Sign In
        </Link>
      </p>
    </AuthLayout>
  );
}

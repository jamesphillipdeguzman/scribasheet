import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Trash2 } from "lucide-react";
import { AppShell } from "@/components/AppShell";
import { Button } from "@/components/ui/Button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/Card";
import { Input } from "@/components/ui/Input";
import { useAuth } from "@/features/auth/AuthContext";
import { api } from "@/services/api";

export function SettingsPage() {
  const { user, usage, refreshUser, logout } = useAuth();
  const navigate = useNavigate();
  const [displayName, setDisplayName] = useState(user?.display_name || "");
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const handleSaveProfile = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setFeedback(null);
    try {
      await api.updateMe({ display_name: displayName });
      await refreshUser();
      setFeedback("Profile updated.");
    } catch (err) {
      setFeedback(err instanceof Error ? err.message : "Failed to update profile.");
    } finally {
      setSaving(false);
    }
  };

  const handleDeleteAccount = async () => {
    await api.deleteMe();
    logout();
    navigate("/");
  };

  return (
    <AppShell>
      <div className="mx-auto max-w-3xl px-4 py-8 sm:px-6 space-y-6">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Account Settings</h1>
          <p className="text-sm text-[#A1A1AA]">Manage your profile, plan usage, and privacy controls.</p>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>Profile</CardTitle>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleSaveProfile} className="space-y-4">
              <Input label="Email" value={user?.email || ""} disabled />
              <Input
                label="Display Name"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                required
              />
              {feedback && <p className="text-xs text-[#A78BFA]">{feedback}</p>}
              <Button type="submit" disabled={saving}>
                {saving ? "Saving..." : "Save Profile"}
              </Button>
            </form>
          </CardContent>
        </Card>

        {usage && (
          <Card>
            <CardHeader>
              <CardTitle>Plan &amp; Usage ({usage.plan_tier.toUpperCase()})</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-4 sm:grid-cols-3 text-sm">
              <div className="rounded-lg border border-[#27273A] bg-[#09090F] p-4">
                <div className="text-xs text-[#A1A1AA]">Monthly Minutes</div>
                <div className="mt-1 text-lg font-semibold">
                  {usage.monthly_minutes_used} / {usage.monthly_minutes_limit}
                </div>
              </div>
              <div className="rounded-lg border border-[#27273A] bg-[#09090F] p-4">
                <div className="text-xs text-[#A1A1AA]">Projects</div>
                <div className="mt-1 text-lg font-semibold">
                  {usage.project_count} / {usage.project_limit}
                </div>
              </div>
              <div className="rounded-lg border border-[#27273A] bg-[#09090F] p-4">
                <div className="text-xs text-[#A1A1AA]">Private Storage</div>
                <div className="mt-1 text-lg font-semibold">
                  {usage.storage_used_mb} / {usage.storage_limit_mb} MB
                </div>
              </div>
            </CardContent>
          </Card>
        )}

        <Card className="border-red-500/30">
          <CardHeader>
            <CardTitle className="text-red-300">Danger Zone</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-sm text-[#A1A1AA]">
              Permanently delete your account, all projects, uploaded recordings, and exported files.
            </p>
            {!confirmDelete ? (
              <Button variant="danger" size="sm" onClick={() => setConfirmDelete(true)}>
                <Trash2 className="h-4 w-4" />
                Delete Account
              </Button>
            ) : (
              <div className="flex items-center gap-3">
                <Button variant="danger" size="sm" onClick={handleDeleteAccount}>
                  Confirm Permanent Deletion
                </Button>
                <Button variant="ghost" size="sm" onClick={() => setConfirmDelete(false)}>
                  Cancel
                </Button>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </AppShell>
  );
}

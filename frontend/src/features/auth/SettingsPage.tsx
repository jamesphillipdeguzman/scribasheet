import { useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Trash2 } from "lucide-react";
import { AppShell } from "@/components/AppShell";
import { Button } from "@/components/ui/Button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/Card";
import { Input } from "@/components/ui/Input";
import { useAuth } from "@/features/auth/AuthContext";
import { DeleteAccountModal } from "@/features/auth/DeleteAccountModal";
import { formatBytes } from "@/lib/utils";
import { api } from "@/services/api";

function getStorageStatusMeta(status?: string): { label: string; className: string } {
  switch (status) {
    case "full":
      return {
        label: "Volume Full",
        className:
          "bg-red-100 text-red-900 border border-red-300 dark:bg-red-500/15 dark:text-red-300 dark:border-red-500/30",
      };
    case "low_space":
      return {
        label: "Low Server Space",
        className:
          "bg-amber-100 text-amber-900 border border-amber-300 dark:bg-amber-500/15 dark:text-amber-300 dark:border-amber-500/30",
      };
    case "unavailable":
      return {
        label: "Storage Unavailable",
        className:
          "bg-red-100 text-red-900 border border-red-300 dark:bg-red-500/15 dark:text-red-300 dark:border-red-500/30",
      };
    default:
      return {
        label: "Available",
        className:
          "bg-emerald-100 text-emerald-900 border border-emerald-300 dark:bg-emerald-500/10 dark:text-emerald-300 dark:border-emerald-500/35",
      };
  }
}

export function SettingsPage() {
  const { user, usage, refreshUser, logout } = useAuth();
  const navigate = useNavigate();
  const [displayName, setDisplayName] = useState(user?.display_name || "");
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [isDeleteModalOpen, setIsDeleteModalOpen] = useState(false);
  const deleteButtonRef = useRef<HTMLButtonElement | null>(null);

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
    setIsDeleteModalOpen(false);
    logout();
    navigate("/", { replace: true });
  };

  return (
    <AppShell>
      <div className="mx-auto max-w-3xl px-4 pt-10 pb-8 sm:px-6 sm:pt-12 space-y-6">
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

        {usage && (() => {
          const isUnlimited = Boolean(usage.is_unlimited || user?.is_unlimited);
          const planLabel = usage.plan_label || (isUnlimited ? "UNLIMITED" : usage.plan_tier.toUpperCase());
          const storageUsedDisplay =
            typeof usage.storage_used_bytes === "number"
              ? formatBytes(usage.storage_used_bytes)
              : `${usage.storage_used_mb} MB`;
          const statusMeta = getStorageStatusMeta(usage.storage_status);
          return (
            <Card>
              <CardHeader>
                <CardTitle>Plan &amp; Usage ({planLabel})</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid gap-4 sm:grid-cols-3 text-sm">
                  <div className="rounded-lg border border-[#27273A] bg-[#09090F] p-4">
                    <div className="text-xs text-[#A1A1AA]">Monthly Minutes</div>
                    <div className="mt-1 text-lg font-semibold">
                      {isUnlimited
                        ? `${usage.monthly_minutes_used} min used`
                        : `${usage.monthly_minutes_used} / ${usage.monthly_minutes_limit} min`}
                    </div>
                  </div>
                  <div className="rounded-lg border border-[#27273A] bg-[#09090F] p-4">
                    <div className="text-xs text-[#A1A1AA]">Stored Projects</div>
                    <div className="mt-1 text-lg font-semibold">{usage.project_count}</div>
                    <div className="mt-1 text-xs text-[#A1A1AA]">No application project cap</div>
                  </div>
                  <div className="rounded-lg border border-[#27273A] bg-[#09090F] p-4">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-xs text-[#A1A1AA]">Private Storage Used</span>
                      <span
                        data-testid="storage-health-badge"
                        className={`whitespace-nowrap shrink-0 inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-semibold ${statusMeta.className}`}
                      >
                        {statusMeta.label}
                      </span>
                    </div>
                    <div className="mt-1 text-lg font-semibold" data-testid="private-storage-used">
                      {storageUsedDisplay}
                    </div>
                    {typeof usage.file_count === "number" && (
                      <div className="mt-1 text-xs text-[#A1A1AA]">
                        {usage.file_count} stored {usage.file_count === 1 ? "file" : "files"}
                      </div>
                    )}
                  </div>
                </div>
                <p className="text-xs text-[#A1A1AA]" data-testid="storage-policy-note">
                  No application storage quota. You can store projects and supported files without an artificial per-user cap, subject to available server storage capacity.
                </p>
              </CardContent>
            </Card>
          );
        })()}

        <Card className="border-red-300 dark:border-red-500/30">
          <CardHeader>
            <CardTitle className="text-red-700 dark:text-red-300">Danger Zone</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-sm text-[#A1A1AA]">
              Permanently delete your account, all projects, uploaded recordings, and exported files.
            </p>
            <Button
              ref={deleteButtonRef}
              variant="danger"
              size="sm"
              onClick={() => setIsDeleteModalOpen(true)}
            >
              <Trash2 className="h-4 w-4" />
              Delete Account
            </Button>
          </CardContent>
        </Card>
      </div>

      <DeleteAccountModal
        isOpen={isDeleteModalOpen}
        userEmail={user?.email}
        onClose={() => setIsDeleteModalOpen(false)}
        onConfirmDelete={handleDeleteAccount}
        restoreFocusRef={deleteButtonRef}
      />
    </AppShell>
  );
}

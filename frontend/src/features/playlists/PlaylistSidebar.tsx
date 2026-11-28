import { useState } from "react";
import { Check, Copy, FolderPlus, Globe, Lock, Pencil, Plus, Search, Share2, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Card, CardContent } from "@/components/ui/Card";
import type { Playlist, PlaylistCategory } from "@/features/playlists/playlistTypes";
import { cn } from "@/lib/utils";

interface PlaylistSidebarProps {
  categories: PlaylistCategory[];
  playlists: Playlist[];
  selectedPlaylistId: string | null;
  activeCategoryFilter: string;
  onCategoryFilterChange: (categoryId: string) => void;
  onSelectPlaylist: (playlistId: string) => void;
  onAddCategory: (name: string) => PlaylistCategory | null;
  onDeleteCategory: (categoryId: string) => void;
  onCreatePlaylist: (title: string, categoryId: string) => void;
  onRenamePlaylist: (playlistId: string, title: string) => void;
  onSetPlaylistCategory: (playlistId: string, categoryId: string) => void;
  onDuplicatePlaylist: (playlistId: string) => void;
  onDeletePlaylist: (playlistId: string) => void;
  onSharePlaylist: (playlistId: string) => void;
}

export function PlaylistSidebar({
  categories,
  playlists,
  selectedPlaylistId,
  activeCategoryFilter,
  onCategoryFilterChange,
  onSelectPlaylist,
  onAddCategory,
  onDeleteCategory,
  onCreatePlaylist,
  onRenamePlaylist,
  onSetPlaylistCategory,
  onDuplicatePlaylist,
  onDeletePlaylist,
  onSharePlaylist,
}: PlaylistSidebarProps) {
  const [categorySearch, setCategorySearch] = useState("");
  const [showNewCategory, setShowNewCategory] = useState(false);
  const [newCategoryName, setNewCategoryName] = useState("");
  const [showNewPlaylist, setShowNewPlaylist] = useState(false);
  const [newPlaylistTitle, setNewPlaylistTitle] = useState("");
  const [newPlaylistCategory, setNewPlaylistCategory] = useState(
    categories[0]?.id ?? "cat-practice-reference",
  );

  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  const categoryMap = new Map(categories.map((c) => [c.id, c]));

  const filteredCategories = categories.filter((c) =>
    categorySearch.trim()
      ? c.name.toLowerCase().includes(categorySearch.trim().toLowerCase())
      : true,
  );

  const filteredPlaylists =
    activeCategoryFilter === "all"
      ? playlists
      : playlists.filter((pl) => pl.categoryId === activeCategoryFilter);

  const handleCreateCategorySubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const created = onAddCategory(newCategoryName);
    if (created) {
      setNewCategoryName("");
      setShowNewCategory(false);
      onCategoryFilterChange(created.id);
    }
  };

  const handleCreatePlaylistSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newPlaylistTitle.trim()) return;
    const catId =
      activeCategoryFilter !== "all" ? activeCategoryFilter : newPlaylistCategory;
    onCreatePlaylist(newPlaylistTitle, catId);
    setNewPlaylistTitle("");
    setShowNewPlaylist(false);
  };

  return (
    <div className="space-y-4" data-testid="playlists-sidebar">
      {/* Categories Filter Section */}
      <Card>
        <CardContent className="p-3.5 space-y-3">
          <div className="flex items-center justify-between gap-2">
            <h2 className="text-xs font-semibold uppercase tracking-wider text-stone-600 dark:text-[#A1A1AA]">
              Categories
            </h2>
            <button
              type="button"
              data-testid="new-category-btn"
              onClick={() => setShowNewCategory((v) => !v)}
              className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium text-violet-700 hover:bg-violet-50 dark:text-[#A78BFA] dark:hover:bg-violet-500/15"
            >
              <FolderPlus className="h-3.5 w-3.5" />
              + New Category
            </button>
          </div>

          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-stone-400 dark:text-[#71717A]" />
            <input
              type="search"
              value={categorySearch}
              onChange={(e) => setCategorySearch(e.target.value)}
              placeholder="Filter categories..."
              aria-label="Filter categories"
              className="h-8 w-full rounded-lg border border-stone-300 bg-white pl-8 pr-2.5 text-xs text-stone-900 placeholder:text-stone-400 focus:border-[#A78BFA] focus:outline-none dark:border-[#27273A] dark:bg-[#09090F] dark:text-[#F5F3FF] dark:placeholder:text-[#52526B]"
            />
          </div>

          {showNewCategory && (
            <form onSubmit={handleCreateCategorySubmit} className="flex gap-1.5">
              <input
                type="text"
                value={newCategoryName}
                onChange={(e) => setNewCategoryName(e.target.value)}
                placeholder="Custom category name"
                aria-label="Custom category name"
                className="h-8 min-w-0 flex-1 rounded-lg border border-stone-300 bg-white px-2.5 text-xs text-stone-900 focus:border-[#A78BFA] focus:outline-none dark:border-[#27273A] dark:bg-[#09090F] dark:text-[#F5F3FF]"
              />
              <Button type="submit" size="sm">
                Add
              </Button>
            </form>
          )}

          <div className="flex flex-wrap gap-1.5" role="group" aria-label="Playlist categories">
            <button
              type="button"
              data-testid="category-pill-all"
              onClick={() => onCategoryFilterChange("all")}
              className={cn(
                "rounded-full border px-2.5 py-1 text-[11px] font-medium transition-colors",
                activeCategoryFilter === "all"
                  ? "border-violet-500 bg-violet-100 text-violet-900 dark:border-violet-400 dark:bg-violet-500/20 dark:text-violet-200"
                  : "border-stone-300 bg-white text-stone-700 hover:bg-stone-100 dark:border-[#27273A] dark:bg-[#11111B] dark:text-[#A1A1AA] dark:hover:text-white",
              )}
            >
              All ({playlists.length})
            </button>
            {filteredCategories.map((cat) => {
              const active = activeCategoryFilter === cat.id;
              return (
                <div key={cat.id} className="inline-flex items-center gap-0.5">
                  <button
                    type="button"
                    data-testid={`category-pill-${cat.id}`}
                    onClick={() => onCategoryFilterChange(cat.id)}
                    className={cn(
                      "rounded-full border px-2.5 py-1 text-[11px] font-medium transition-colors",
                      active
                        ? "border-violet-500 bg-violet-100 text-violet-900 dark:border-violet-400 dark:bg-violet-500/20 dark:text-violet-200"
                        : "border-stone-300 bg-white text-stone-700 hover:bg-stone-100 dark:border-[#27273A] dark:bg-[#11111B] dark:text-[#A1A1AA] dark:hover:text-white",
                    )}
                  >
                    {cat.name}
                  </button>
                  {!cat.isDefault && (
                    <button
                      type="button"
                      aria-label={`Delete category ${cat.name}`}
                      onClick={() => {
                        if (active) onCategoryFilterChange("all");
                        onDeleteCategory(cat.id);
                      }}
                      className="rounded p-0.5 text-stone-400 hover:text-red-500"
                      title="Delete custom category"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        </CardContent>
      </Card>

      {/* Playlists Section */}
      <Card>
        <CardContent className="p-3.5 space-y-3">
          <div className="flex items-center justify-between gap-2">
            <h2 className="text-xs font-semibold uppercase tracking-wider text-stone-600 dark:text-[#A1A1AA]">
              Playlists ({filteredPlaylists.length})
            </h2>
            <Button
              type="button"
              size="sm"
              data-testid="new-playlist-btn"
              onClick={() => {
                setNewPlaylistCategory(
                  activeCategoryFilter !== "all"
                    ? activeCategoryFilter
                    : categories[0]?.id ?? "cat-practice-reference",
                );
                setShowNewPlaylist((v) => !v);
              }}
            >
              <Plus className="h-3.5 w-3.5" />
              + New Playlist
            </Button>
          </div>

          {showNewPlaylist && (
            <form
              onSubmit={handleCreatePlaylistSubmit}
              className="space-y-2 rounded-lg border border-stone-200 bg-stone-50 p-2.5 dark:border-[#27273A] dark:bg-[#09090F]"
            >
              <input
                type="text"
                value={newPlaylistTitle}
                onChange={(e) => setNewPlaylistTitle(e.target.value)}
                placeholder="e.g., Violin Concerto Practice"
                aria-label="New playlist title"
                className="h-8 w-full rounded-lg border border-stone-300 bg-white px-2.5 text-xs text-stone-900 focus:border-[#A78BFA] focus:outline-none dark:border-[#27273A] dark:bg-[#11111B] dark:text-[#F5F3FF]"
              />
              <select
                aria-label="New playlist category"
                value={newPlaylistCategory}
                onChange={(e) => setNewPlaylistCategory(e.target.value)}
                className="h-8 w-full rounded-lg border border-stone-300 bg-white px-2 text-xs text-stone-900 focus:border-[#A78BFA] focus:outline-none dark:border-[#27273A] dark:bg-[#11111B] dark:text-[#F5F3FF]"
              >
                {categories.map((cat) => (
                  <option key={cat.id} value={cat.id}>
                    {cat.name}
                  </option>
                ))}
              </select>
              <div className="flex justify-end gap-1.5">
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => setShowNewPlaylist(false)}
                >
                  Cancel
                </Button>
                <Button type="submit" size="sm" data-testid="confirm-create-playlist-btn">
                  Create
                </Button>
              </div>
            </form>
          )}

          {filteredPlaylists.length === 0 ? (
            <div
              data-testid="playlists-empty-state"
              className="rounded-xl border border-dashed border-stone-300 p-5 text-center text-xs text-stone-600 dark:border-[#27273A] dark:text-[#A1A1AA]"
            >
              {playlists.length === 0
                ? "No playlists yet. Click + New Playlist to create your first listening or practice list."
                : "No playlists match the selected category filter."}
            </div>
          ) : (
            <div className="space-y-2">
              {filteredPlaylists.map((pl) => {
                const isSelected = pl.id === selectedPlaylistId;
                const catName = categoryMap.get(pl.categoryId)?.name ?? "Practice / Reference";
                const isRenaming = renamingId === pl.id;
                const isConfirmingDelete = confirmDeleteId === pl.id;

                return (
                  <div
                    key={pl.id}
                    data-testid={`playlist-card-${pl.id}`}
                    className={cn(
                      "rounded-xl border p-2.5 transition-colors space-y-2",
                      isSelected
                        ? "border-violet-500 bg-violet-50/70 dark:border-[#A78BFA]/70 dark:bg-violet-500/10"
                        : "border-stone-200 bg-white hover:border-stone-300 dark:border-[#27273A] dark:bg-[#11111B] dark:hover:border-white/20",
                    )}
                  >
                    {isRenaming ? (
                      <form
                        onSubmit={(e) => {
                          e.preventDefault();
                          onRenamePlaylist(pl.id, renameDraft);
                          setRenamingId(null);
                        }}
                        className="flex items-center gap-1"
                      >
                        <input
                          type="text"
                          value={renameDraft}
                          onChange={(e) => setRenameDraft(e.target.value)}
                          aria-label={`Rename playlist ${pl.title}`}
                          className="h-7 min-w-0 flex-1 rounded border border-violet-400 bg-white px-2 text-xs text-stone-900 focus:outline-none dark:bg-[#09090F] dark:text-[#F5F3FF]"
                          autoFocus
                        />
                        <button
                          type="submit"
                          aria-label="Save playlist title"
                          className="inline-flex h-7 w-7 items-center justify-center rounded bg-violet-600 text-white hover:bg-violet-700"
                        >
                          <Check className="h-3.5 w-3.5" />
                        </button>
                        <button
                          type="button"
                          aria-label="Cancel rename"
                          onClick={() => setRenamingId(null)}
                          className="inline-flex h-7 w-7 items-center justify-center rounded border border-stone-300 text-stone-600 dark:border-[#27273A] dark:text-[#A1A1AA]"
                        >
                          <X className="h-3.5 w-3.5" />
                        </button>
                      </form>
                    ) : (
                      <button
                        type="button"
                        onClick={() => onSelectPlaylist(pl.id)}
                        className="w-full text-left"
                      >
                        <div className="flex items-start justify-between gap-2">
                          <span className="text-sm font-semibold leading-snug text-stone-900 dark:text-[#F5F3FF] break-words">
                            {pl.title}
                          </span>
                          <span className="shrink-0 rounded-full bg-stone-200/80 px-2 py-0.5 text-[10px] font-semibold text-stone-700 dark:bg-white/10 dark:text-slate-200">
                            {pl.tracks.length} {pl.tracks.length === 1 ? "track" : "tracks"}
                          </span>
                        </div>
                        <div className="mt-1 flex flex-wrap items-center gap-1">
                          <span className="inline-flex rounded bg-violet-100 px-1.5 py-0.5 text-[10px] font-medium text-violet-900 dark:bg-violet-500/20 dark:text-violet-300">
                            {catName}
                          </span>
                          <span
                            data-testid={`playlist-privacy-badge-${pl.id}`}
                            className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium ${
                              pl.isShared && pl.shareToken
                                ? "bg-emerald-100 text-emerald-900 dark:bg-emerald-500/20 dark:text-emerald-300"
                                : "bg-stone-200/70 text-stone-700 dark:bg-white/10 dark:text-[#A1A1AA]"
                            }`}
                          >
                            {pl.isShared && pl.shareToken ? (
                              <>
                                <Globe className="h-2.5 w-2.5" />
                                Public Link
                              </>
                            ) : (
                              <>
                                <Lock className="h-2.5 w-2.5" />
                                Private
                              </>
                            )}
                          </span>
                        </div>
                      </button>
                    )}

                    <div className="flex items-center justify-between gap-1.5 pt-0.5">
                      <select
                        aria-label={`Category for ${pl.title}`}
                        value={pl.categoryId}
                        onChange={(e) => onSetPlaylistCategory(pl.id, e.target.value)}
                        className="h-7 min-w-0 flex-1 rounded border border-stone-200 bg-stone-50 px-1.5 text-[11px] text-stone-700 focus:outline-none dark:border-[#27273A] dark:bg-[#09090F] dark:text-[#A1A1AA]"
                      >
                        {categories.map((cat) => (
                          <option key={cat.id} value={cat.id}>
                            {cat.name}
                          </option>
                        ))}
                      </select>

                      <div className="flex items-center gap-0.5 shrink-0">
                        <button
                          type="button"
                          data-testid={`share-playlist-btn-${pl.id}`}
                          aria-label={`Share ${pl.title}`}
                          title="Share playlist link"
                          onClick={() => onSharePlaylist(pl.id)}
                          className="inline-flex h-7 items-center gap-1 rounded px-1.5 text-[11px] font-medium text-violet-700 hover:bg-violet-100 dark:text-[#A78BFA] dark:hover:bg-violet-500/20"
                        >
                          <Share2 className="h-3.5 w-3.5" />
                          <span>Share</span>
                        </button>
                        <button
                          type="button"
                          aria-label={`Rename ${pl.title}`}
                          title="Rename playlist"
                          onClick={() => {
                            setRenamingId(pl.id);
                            setRenameDraft(pl.title);
                          }}
                          className="inline-flex h-7 w-7 items-center justify-center rounded text-stone-500 hover:bg-stone-200 hover:text-stone-900 dark:text-[#A1A1AA] dark:hover:bg-white/10 dark:hover:text-white"
                        >
                          <Pencil className="h-3.5 w-3.5" />
                        </button>
                        <button
                          type="button"
                          aria-label={`Duplicate ${pl.title}`}
                          title="Duplicate playlist"
                          onClick={() => onDuplicatePlaylist(pl.id)}
                          className="inline-flex h-7 w-7 items-center justify-center rounded text-stone-500 hover:bg-stone-200 hover:text-stone-900 dark:text-[#A1A1AA] dark:hover:bg-white/10 dark:hover:text-white"
                        >
                          <Copy className="h-3.5 w-3.5" />
                        </button>
                        <button
                          type="button"
                          aria-label={`Delete ${pl.title}`}
                          title="Delete playlist"
                          onClick={() => setConfirmDeleteId(pl.id)}
                          className="inline-flex h-7 w-7 items-center justify-center rounded text-stone-500 hover:bg-red-100 hover:text-red-700 dark:text-[#A1A1AA] dark:hover:bg-red-500/15 dark:hover:text-red-300"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    </div>

                    {isConfirmingDelete && (
                      <div
                        role="alertdialog"
                        aria-label={`Confirm delete ${pl.title}`}
                        className="rounded-lg border border-red-300 bg-red-50 p-2 text-[11px] text-red-900 space-y-2 dark:border-red-500/40 dark:bg-red-500/10 dark:text-red-200"
                      >
                        <p>Delete playlist &ldquo;{pl.title}&rdquo;? Original ScribaSheet projects will not be deleted.</p>
                        <div className="flex justify-end gap-1.5">
                          <Button
                            type="button"
                            size="sm"
                            variant="ghost"
                            onClick={() => setConfirmDeleteId(null)}
                          >
                            Cancel
                          </Button>
                          <Button
                            type="button"
                            size="sm"
                            variant="danger"
                            onClick={() => {
                              setConfirmDeleteId(null);
                              onDeletePlaylist(pl.id);
                            }}
                          >
                            Confirm Delete
                          </Button>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

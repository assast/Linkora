ALTER TABLE "user_preferences"
  ADD COLUMN "bookmark_font_size" INTEGER NOT NULL DEFAULT 12,
  ADD COLUMN "category_font_size" INTEGER NOT NULL DEFAULT 12,
  ADD COLUMN "show_workspace" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "workspace_items" TEXT[] NOT NULL DEFAULT ARRAY['home', 'all', 'starred', 'private']::TEXT[];

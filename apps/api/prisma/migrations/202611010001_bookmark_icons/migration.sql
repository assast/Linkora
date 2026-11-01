CREATE TYPE "IconSource" AS ENUM ('AUTO', 'DASHBOARD', 'UPLOAD');

CREATE TABLE bookmark_icons (
  bookmark_id UUID PRIMARY KEY REFERENCES bookmarks(id) ON DELETE CASCADE,
  source "IconSource" NOT NULL,
  version UUID NOT NULL,
  dashboard_id VARCHAR(120),
  dashboard_commit CHAR(40),
  dashboard_format VARCHAR(4),
  upload_key UUID,
  CONSTRAINT bookmark_icon_source_fields CHECK (
    (source = 'AUTO' AND dashboard_id IS NULL AND dashboard_commit IS NULL AND dashboard_format IS NULL AND upload_key IS NULL)
    OR (source = 'DASHBOARD' AND dashboard_id IS NOT NULL AND dashboard_id ~ '^[a-z0-9][a-z0-9-]{0,119}$'
      AND dashboard_commit IS NOT NULL AND dashboard_commit ~ '^[a-f0-9]{40}$'
      AND dashboard_format IS NOT NULL AND dashboard_format IN ('png', 'webp') AND upload_key IS NULL)
    OR (source = 'UPLOAD' AND upload_key IS NOT NULL AND dashboard_id IS NULL AND dashboard_commit IS NULL AND dashboard_format IS NULL)
  )
);

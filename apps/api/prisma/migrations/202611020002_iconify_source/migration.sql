ALTER TYPE "IconSource" ADD VALUE 'ICONIFY';

ALTER TABLE bookmark_icons ADD COLUMN iconify_id VARCHAR(160);
ALTER TABLE bookmark_icons DROP CONSTRAINT bookmark_icon_source_fields;
ALTER TABLE bookmark_icons ADD CONSTRAINT bookmark_icon_source_fields CHECK (
  (source = 'AUTO' AND dashboard_id IS NULL AND dashboard_commit IS NULL AND dashboard_format IS NULL AND upload_key IS NULL AND iconify_id IS NULL)
  OR (source = 'DASHBOARD' AND dashboard_id IS NOT NULL AND dashboard_id ~ '^[a-z0-9][a-z0-9-]{0,119}$'
    AND dashboard_commit IS NOT NULL AND dashboard_commit ~ '^[a-f0-9]{40}$'
    AND dashboard_format IS NOT NULL AND dashboard_format IN ('png', 'webp') AND upload_key IS NULL AND iconify_id IS NULL)
  OR (source = 'UPLOAD' AND upload_key IS NOT NULL AND dashboard_id IS NULL AND dashboard_commit IS NULL AND dashboard_format IS NULL AND iconify_id IS NULL)
  OR (source::text = 'ICONIFY' AND iconify_id IS NOT NULL AND iconify_id ~ '^[a-z0-9]+(-[a-z0-9]+)*:[a-z0-9]+(-[a-z0-9]+)*$'
    AND dashboard_id IS NULL AND dashboard_commit IS NULL AND dashboard_format IS NULL AND upload_key IS NULL)
);

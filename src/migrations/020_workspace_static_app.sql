-- Static app hosting: persist the built frontend path for direct file serving
ALTER TABLE workspaces ADD COLUMN static_app_path TEXT;

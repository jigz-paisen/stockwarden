

-- ================================================
-- SEED: Default admin account
-- Username: admin
-- Password: Admin@1234  (bcrypt hash below)
-- IMPORTANT: Change this password after first login
-- ================================================

INSERT IGNORE INTO users (username, email, password, role, is_active)
VALUES (
  'admin',
  'admin@stockwarden.local',
  '$2b$10$92IXUNpkjO0rOQ5byMi.Ye4oKoEa3Ro9llC/.og/at2.uheWG/igi',
  'admin',
  1
);

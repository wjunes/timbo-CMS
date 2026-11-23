-- Migración 009 (Bloque 12): modo de color del panel para cada administrador (D-071).
--
-- Preferencia personal de presentación: 'auto' sigue el modo del sistema
-- operativo; 'light' y 'dark' lo fijan. No concede ni limita nada.

ALTER TABLE users ADD COLUMN ui_mode TEXT NOT NULL DEFAULT 'auto' CHECK (ui_mode IN ('auto', 'light', 'dark'));

// Room settings: the schema lives in shared/settings.ts (one source for back and front). This module re-exports it.
export {
  DEFAULT_SETTINGS,
  STARTING_CASH_OPTIONS,
  roomSettingsSchema,
  settingsPatchSchema,
  type RoomSettings,
  type SettingsPatch,
} from "../shared/settings.js";

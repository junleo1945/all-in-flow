import type { CurrentUser } from "../auth/service.js";
import type { Locale } from "../i18n.js";

export type AppVariables = {
  user: CurrentUser;
  sid: string;
  locale: Locale;
};

export const SID_COOKIE = "aif_sid";

import type { CurrentUser } from "../auth/service.js";

export type AppVariables = {
  user: CurrentUser;
  sid: string;
};

export const SID_COOKIE = "aif_sid";

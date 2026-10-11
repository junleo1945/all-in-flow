import type { Profile } from "./types";

export const emptyProfile = (): Profile => ({ role: { systems: [] }, tasks: [], painPoints: [], candidates: [] });

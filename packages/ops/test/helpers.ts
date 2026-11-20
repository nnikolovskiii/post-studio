import { readFileSync } from "node:fs";
import type { Document } from "@post-studio/schema";

export const loadFixture = (name = "lux-6-square.hand.json"): Document =>
  JSON.parse(readFileSync(new URL(`../../../fixtures/${name}`, import.meta.url), "utf8"));

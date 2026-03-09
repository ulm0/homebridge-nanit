import type { NanitApiClient } from '../nanit/api.js';

export function getCloudStreamUrl(api: NanitApiClient, babyUid: string): Promise<string> {
  return api.getCloudStreamUrl(babyUid);
}

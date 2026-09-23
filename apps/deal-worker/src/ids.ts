import { isUuid, uuidFromPublicId, uuidToHex, type Uuid } from "@saas/db/ids";

export function generateRequestId(): string {
  const buf = new Uint8Array(12);
  crypto.getRandomValues(buf);
  let hex = "";
  for (let i = 0; i < buf.length; i++) hex += buf[i]!.toString(16).padStart(2, "0");
  return `req_${hex}`;
}

export const orgPublicId = (uuid: string): string => `org_${uuidToHex(uuid)}`;
export const parseOrgPublicId = (id: string): Uuid | null => uuidFromPublicId(id, "org");

export const publicationPublicId = (uuid: string): string => `rbp_${uuidToHex(uuid)}`;
export const parsePublicationPublicId = (id: string): Uuid | null => uuidFromPublicId(id, "rbp");

export const issuePublicId = (uuid: string): string => `rbi_${uuidToHex(uuid)}`;
export const parseIssuePublicId = (id: string): Uuid | null => uuidFromPublicId(id, "rbi");

export const slotPublicId = (uuid: string): string => `rbs_${uuidToHex(uuid)}`;
export const parseSlotPublicId = (id: string): Uuid | null => uuidFromPublicId(id, "rbs");

export const sponsorPublicId = (uuid: string): string => `rbn_${uuidToHex(uuid)}`;
export const parseSponsorPublicId = (id: string): Uuid | null => uuidFromPublicId(id, "rbn");

export const dealPublicId = (uuid: string): string => `rbd_${uuidToHex(uuid)}`;
export const parseDealPublicId = (id: string): Uuid | null => uuidFromPublicId(id, "rbd");

export const bookingPublicId = (uuid: string): string => `rbb_${uuidToHex(uuid)}`;
export const parseBookingPublicId = (id: string): Uuid | null => uuidFromPublicId(id, "rbb");

/**
 * The actor id in the shape a UUID column takes: pass a UUID through, decode a
 * `usr_<hex>` public id, and write null rather than garbage for anything else.
 */
export function actorSubjectUuid(subjectId: string): string | null {
  if (isUuid(subjectId)) return subjectId;
  return uuidFromPublicId(subjectId);
}

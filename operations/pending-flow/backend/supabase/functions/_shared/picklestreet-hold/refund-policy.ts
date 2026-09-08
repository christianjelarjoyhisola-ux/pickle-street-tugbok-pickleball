// @ts-nocheck
import { RequestError } from "../http.ts";
const POLICY_KEY = "refund_reschedule_policy";
const POLICY_HASH_SCHEMA = "refund_reschedule_policy_acceptance_v1";
const POLICY_KEYS = [
  "content",
  "intro",
  "ownerApproved",
  "title",
  "version"
];
const POLICY_VERSION_PATTERN = /^[a-z0-9][a-z0-9._:-]{2,119}$/i;
const UNPUBLISHED_VERSION_PATTERN = /setup|required|unapproved|draft/i;
function isObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function exactPolicyKeys(value) {
  const keys = Object.keys(value).sort();
  return keys.length === POLICY_KEYS.length && keys.every((key, index)=>key === POLICY_KEYS[index]);
}
function canonicalTextField(value, minimum, maximum, normalizeLineEndings = false) {
  if (typeof value !== "string") return null;
  const normalized = normalizeLineEndings ? value.replace(/\r\n?/g, "\n").trim() : value.trim();
  if (value !== normalized || normalized.length < minimum || normalized.length > maximum) {
    return null;
  }
  return normalized;
}
export function parseApprovedRefundReschedulePolicy(value) {
  if (!isObject(value) || !exactPolicyKeys(value)) return null;
  if (value.ownerApproved !== true) return null;
  const version = canonicalTextField(value.version, 3, 120);
  const title = canonicalTextField(value.title, 3, 180);
  const intro = canonicalTextField(value.intro, 10, 1_200);
  const content = canonicalTextField(value.content, 20, 30_000, true);
  if (!version || !title || !intro || !content || !POLICY_VERSION_PATTERN.test(version) || UNPUBLISHED_VERSION_PATTERN.test(version)) {
    return null;
  }
  return {
    version,
    title,
    intro,
    content,
    ownerApproved: true
  };
}
function utf8Length(value) {
  return new TextEncoder().encode(value).byteLength;
}
export function canonicalRefundPolicyText(policy) {
  return [
    POLICY_HASH_SCHEMA,
    `version=${utf8Length(policy.version)}:${policy.version}`,
    `title=${utf8Length(policy.title)}:${policy.title}`,
    `intro=${utf8Length(policy.intro)}:${policy.intro}`,
    `content=${utf8Length(policy.content)}:${policy.content}`,
    "ownerApproved=true"
  ].join("\n");
}
export async function refundPolicySha256(policy) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonicalRefundPolicyText(policy)));
  return Array.from(new Uint8Array(digest)).map((byte)=>byte.toString(16).padStart(2, "0")).join("");
}
export async function requireCurrentRefundPolicyAcceptance(setting, acceptance) {
  // Backward compatibility is deliberate: tenants that have never published
  // this setting retain the existing public-booking contract.
  if (!setting) return null;
  const policy = setting.is_public === true ? parseApprovedRefundReschedulePolicy(setting.value) : null;
  if (!policy) {
    throw new RequestError(503, "BOOKING_POLICY_NOT_CONFIGURED", "Online booking is unavailable until the venue publishes an approved refund and reschedule policy.");
  }
  if (acceptance.accepted !== true || !acceptance.version) {
    throw new RequestError(400, "POLICY_ACCEPTANCE_REQUIRED", "Please review and accept the current refund and reschedule policy.");
  }
  if (acceptance.version !== policy.version) {
    throw new RequestError(409, "POLICY_VERSION_STALE", "The venue policy changed. Please reload, review, and accept the current version.");
  }
  return {
    accepted: true,
    version: policy.version,
    sha256: await refundPolicySha256(policy)
  };
}
export { POLICY_KEY as REFUND_RESCHEDULE_POLICY_KEY };


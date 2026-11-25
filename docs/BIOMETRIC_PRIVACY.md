# Biometric Design & Privacy Gate (BIO-01…BIO-10)

Status: **design only** (Phase 6). Schema exists; nothing is enrolled or matched. Facial verification must not be called secure until
an independently evaluated SDK/model is integrated and benchmarked on representative, consented data.

## Non-negotiables
1. Face is an **alternative credential**, never an eligibility bypass. Same `/access/verify`, same rules, same audit.
2. **Optional.** A comparable non-biometric route (card/QR or supervised manual identity check) always exists. Failure/absence/withdrawal never makes the student ineligible for the underlying service.
3. **No home-made algorithms.** Use a maintained SDK for detection, quality, presentation-attack detection and embeddings. No “blink/smile” liveness claims.
4. **Mock adapter** (until a real SDK is approved) is labelled *prototype-only* in UI, API (`isMock`) and reports; live biometric access stays disabled.
5. Biometric service is **separate**, returns only a **signed, short-lived assertion** bound to reader + nonce + purpose. The access API never trusts a client-supplied `student_id`.
6. **1:1 by default** (claimed identity). **1:N** only behind a default-off flag after privacy review, with a scoped gallery (e.g. exam roster) — never campus-wide by default. Low confidence / ambiguity ⇒ no guess, no grant; staff fallback.
7. **Online-only.** No templates cached on browser readers; offline ⇒ QR/card or supervised check.
8. **Data:** encrypted templates stored apart from profiles; model version + enrolment provenance + consent record + revocation metadata; raw captures discarded promptly; no images/templates/embeddings in logs, analytics, fixtures or browser APIs; no scores on public screens; no training on student data; no continuous surveillance, emotion inference or tracking.
9. **Lifecycle:** enrol (officer verifies identity → notice → consent → samples → quality/liveness → template) · view status · withdraw · delete (subject to legal duties) · re-enrol · admin suspend / template replacement / model migration. All audited.
10. **Fairness/accuracy:** measure FAR/FRR, spoofing and demographic performance and accessibility before any live use; publish only evidenced numbers.

## Required before any live KIU use
Privacy impact assessment · lawful basis / valid consent review under the Uganda Data Protection and Privacy Act, 2019 · retention schedule · transparent notices · security review · human appeal process · explicit institutional approval.

## Card vs. face policy
See [ARCHITECTURE §7](ARCHITECTURE.md). Card LOST/BLOCKED ≠ account suspension; account suspension denies every route. Configurable in `biometric_policies`, tested as FACE-06.

## Tests to implement (FACE-01…10)
Forgot-card grant parity · finance-ineligible still DENY · spoof/liveness failure · unknown/low-confidence/ambiguous · withdrawn consent · lost card with valid face · duplicate meal across QR+face · duplicate exam attendance across QR+face · unauthorised template access/enrolment · face-service-offline safe fallback.

## Update 2026-11-16: compulsory enrolment (D-039)
Face enrolment is now compulsory by institutional decision, with exemptions. This **replaces** the "optional, consent-based" premise of the sections above. Consent is no longer the lawful basis (recorded as `INSTITUTIONAL_REQUIREMENT`); the privacy impact assessment, lawful-basis review and retention schedule listed under "Required before any live KIU use" are therefore **more** necessary, not less. Exemptions (disability, safety, conscientious objection), deletion on request, the no-photograph design and the audit trail remain. See DECISIONS.md D-039 for exactly what the system enforces and what it does not.

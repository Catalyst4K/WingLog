/**
 * BeyondATC's procedure phrases, shared by the Latest instruction card
 * (beyondAtcInstruction.ts) and the procedure update prompt (atc-clearance-parser.ts) so the
 * two can't drift apart — they did once, both missing "via the BIXAD2 departure" on the real
 * YBBN-VHHH flight (2026-10-02), where every earlier capture said "via PECA1D departure".
 *
 * Each pattern finds one fact on its own, tolerating the small words BeyondATC varies
 * ("the", "SID", a comma before "runway"), so one unexpected word can't lose the others.
 * Every real wording on record is in the renderer's atcPhrases.test.ts; add new ones there as they turn up.
 */

// "via PECA1D departure", "via the BIXAD2 departure", "via the BIXAD2 SID".
export const SID = /\bvia (?:the )?([A-Z0-9]{2,8}) (?:departure|SID)\b/i
// "cleared AND1 arrival", "cleared BETY3B arrival", "cleared the BETY3B STAR".
export const STAR = /\bcleared (?:the )?([A-Z0-9]{2,8}) (?:arrival|STAR)\b/i
// "expect the ILS-Z approach runway 17R with the PD201 transition", "expect the ILS approach runway 25L".
export const APPROACH_EXPECT =
  /\bexpect (?:the )?([A-Z0-9]+(?:-[A-Z0-9]+)*) approach,? runway (\d{1,2}[LRC]?)\b(?:,? with the ([A-Z0-9]+) transition)?/i
// "cleared ILS-Z approach runway 17R", "cleared ILS approach runway 25L".
export const APPROACH_CLEARED = /\bcleared (?:the )?([A-Z0-9]+(?:-[A-Z0-9]+)*) approach,? runway (\d{1,2}[LRC]?)\b/i
export const RUNWAY = /\brunway (\d{1,2}[LRC]?)\b/i
// A departure clearance: "cleared to Hong Kong airport via …".
export const CLEARED_TO = /\bcleared to (.+?) via /i

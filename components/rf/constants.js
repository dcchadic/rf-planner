// =====================================================
// RF PLANNER - LOCKED RULE CONSTANTS
// All numbers that affect the optimizer live here.
// Update these in ONE place to change app behavior.
// =====================================================

// ----- DEFAULT START HEIGHTS (ft) -----
export const DEFAULT_HEIGHT_GATEWAY = 15;
export const DEFAULT_HEIGHT_LRA     = 10;
export const DEFAULT_HEIGHT_SRA     = 5;

// ----- MAX ALLOWED HEIGHTS (ft) -----
export const MAX_HEIGHT_GATEWAY = 25;
export const MAX_HEIGHT_LRA     = 20;
export const MAX_HEIGHT_SRA     = 5;

// ----- 1.5x "FLAGGED BUT ALLOWED" HEIGHTS (ft) -----
// Routes can still connect above the normal max,
// but they will be flagged as warnings.
export const FLAG_MAX_HEIGHT_GATEWAY = MAX_HEIGHT_GATEWAY * 1.5; // 37.5
export const FLAG_MAX_HEIGHT_LRA     = MAX_HEIGHT_LRA * 1.5;     // 30
export const FLAG_MAX_HEIGHT_SRA     = MAX_HEIGHT_SRA * 1.5;     // 7.5

// ----- DEVICE RANGES (miles) -----
export const RANGE_GATEWAY = 4;
export const RANGE_LRA     = 3;
export const RANGE_SRA     = 0.75;

// ----- HEIGHT ESCALATION STEP (ft) -----
// When the optimizer raises antennas to clear LOS.
export const HEIGHT_STEP = 5;

// ----- GATEWAY PLACEMENT RULE -----
// After picking the gateway anchor site,
// place the gateway 100 ft NORTH of that site.
export const GATEWAY_OFFSET_NORTH_FT = 100;

// ----- PAD DETECTION RULE -----
// A pad = group of wells within this radius
export const PAD_RADIUS_FT = 200;

// Pad sizes:
// - PAD_MIN_FOR_MANDATORY_LRA: this size or larger MUST get an LRA
// - PAD_MIN_FOR_OPTIONAL_LRA:  pads at this size MAY get an LRA only if it helps
export const PAD_MIN_FOR_MANDATORY_LRA = 3;
export const PAD_MIN_FOR_OPTIONAL_LRA  = 2;

// ----- FRESNEL ZONE RULES -----
// Fresnel is used as a WARNING and TIE-BREAKER only.
// It does NOT disconnect nodes.
export const FRESNEL_WARN_PCT = 60; // below this = warning

// ----- SIGNAL SCORING WEIGHTS -----
// Used when comparing two valid candidate routes.
// LOS matters most, then distance, then Fresnel.
export const SCORE_WEIGHT_LOS      = 1.0;
export const SCORE_WEIGHT_DISTANCE = 0.6;
export const SCORE_WEIGHT_FRESNEL  = 0.3;
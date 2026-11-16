// Wire types of the Ignite sync server's read API (`GET /v1/libraries`, `.../snapshot`).
// Mirrors `ignite/core/sync-protocol/src/snapshot.rs`; only the fields the bridge reads.

export interface IgniteLibrarySummary {
  library_id: string;
  head_server_seq: number;
  snapshot_sha256: string;
  notebook_count: number;
  page_count: number;
}

export interface IgnitePoint { x: number; y: number; pressure?: number | null }

export interface IgniteStroke {
  stroke_id: string;
  root_id: string;
  style: string;
  points: IgnitePoint[];
}

export interface IgniteText {
  text_id: string;
  x: number;
  y: number;
  width: number;
  font_size: number;
  face: string;
  content: string;
}

export type IgniteBackground =
  | { kind: "blank" }
  | { kind: "blob"; sha256: string; byte_len: number; format: { encoding: "gray8"; width: number; height: number; stride: number } };

export interface IgnitePressureCurve {
  q_r1_max: number;
  q_r2_max: number;
  q_r3_max: number;
  min_radius: number;
  max_radius: number;
  missing_fallback_radius: number;
}

export interface IgniteRenderProfile {
  profile_version: number;
  ink_byte: number;
  legacy_fixed_radius?: number;
  pressure?: IgnitePressureCurve;
}

export interface IgnitePage {
  page_id: string;
  background: IgniteBackground;
  render: IgniteRenderProfile;
  strokes: IgniteStroke[];
  texts?: IgniteText[];
}

export interface IgniteNotebook {
  notebook_id: string;
  title: string;
  pages: IgnitePage[];
  folder_id?: string;
}

export interface IgniteSnapshot {
  v: number;
  library_id: string;
  page_space: { width: number; height: number };
  notebooks: IgniteNotebook[];
  folders?: { folder_id: string; title: string }[];
}

export interface IgniteSnapshotResponse {
  library_id: string;
  through_server_seq: number;
  snapshot_sha256: string;
  snapshot: IgniteSnapshot;
}

/** Recognised handwriting for one page version. */
export interface PageTranscription {
  text: string;
  lines: { text: string; confidence: number; x: number; y: number; w: number; h: number }[];
}

/** `GET /v1/libraries/{id}/operations?after=N&limit=M` (only the fields the watcher reads). */
export interface IgniteOperation {
  server_seq: number;
  envelope: {
    replica_id: string;
    operation:
      | { type: "add_stroke"; notebook_id: string; page_id: string; stroke: IgniteStroke }
      | { type: "erase_region"; notebook_id: string; page_id: string; observed_roots?: string[]; path?: IgnitePoint[]; radius?: number }
      | { type: string; notebook_id?: string; page_id?: string; [key: string]: unknown };
  };
}

export interface IgniteOperationsPage {
  library_id: string;
  head_server_seq: number;
  operations: IgniteOperation[];
  next_after: number;
}

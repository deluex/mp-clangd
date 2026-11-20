export interface CompileEntry {
  directory: string;
  file: string;
  arguments: string[];
  /**
   * Diagnostic flag set by a provider when it had to fall back to heuristic
   * arguments (for example after a failed compiler probe). The core preserves
   * the flag through parsing, merging and materialization.
   */
  unverified?: boolean;
}

export interface Profile {
  id: string;
  entries: CompileEntry[];
}

export interface ProfileSet {
  profiles: Profile[];
}

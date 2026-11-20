export interface CompileEntry {
  directory: string;
  file: string;
  arguments: string[];
}

export interface Profile {
  id: string;
  entries: CompileEntry[];
}

export interface ProfileSet {
  profiles: Profile[];
}

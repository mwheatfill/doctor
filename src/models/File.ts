export interface File {
  ID: number;
  CheckInComment: string;
  CheckOutType: number;
  ContentTag: string;
  CustomizedPageStatus: number;
  ETag: string;
  Exists: boolean;
  IrmEnabled: boolean;
  Length: string;
  Level: number;
  LinkingUri?: any;
  LinkingUrl: string;
  MajorVersion: number;
  MinorVersion: number;
  Name: string;
  ServerRelativeUrl: string;
  TimeCreated: string;
  TimeLastModified: string;
  Title: string;
  UIVersion: number;
  UIVersionLabel: string;
  UniqueId: string;
  FileRef?: string;
  /**
   * SHA-256 hash of the source markdown file content as of the last
   * successful publish. Used by the per-page skip-if-unchanged logic.
   * The column is auto-created on the Site Pages list at publish start.
   */
  SourceHash?: string;
}
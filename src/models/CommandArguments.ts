import { MarkdownSettings, Menu, MultilingualSettings, SiteDesign } from ".";
export interface CommandArguments {
  task: string;
  auth: "deviceCode" | "password" | "certificate";
  startFolder: string;
  startFolderRel: string;
  assetLibrary: string;
  webPartTitle: string;
  webUrl: string;
  overwriteImages: boolean;
  skipPrecheck: boolean;
  skipExistingPages: boolean;
  debug: boolean;
  continueOnError: boolean;
  retryWhenFailed: boolean;

  disableComments: boolean;
  disableTracking: boolean;

  skipPages: boolean;
  skipNavigation: boolean;
  skipSiteDesign: boolean;

  cleanEnd: boolean;
  cleanStart: boolean;
  cleanScope: string | null;
  confirm: boolean;

  cleanQuickLaunch: boolean;
  cleanTopNavigation: boolean;

  /**
   * Bypass the SourceHash skip check. By default, pages whose source
   * content hash matches the value stored on the page in SharePoint
   * are skipped (no header update, no markdown re-upload, no metadata
   * touch, no publish, no description update). Set this to true to
   * force every page through the full pipeline — useful after Doctor
   * itself changes (web part property additions, schema changes, etc.)
   * so that all existing pages pick up the new behavior.
   */
  force: boolean;

  pageTemplate: string | null;

  menu?: Menu;
  multilingual?: MultilingualSettings | null;

  username?: string;
  password?: string;
  outputFolder?: string;
  tenant?: string;
  appId?: string;
  certificateBase64Encoded?: string;
  commandName?: string;
  siteDesign?: SiteDesign;
  markdown?: MarkdownSettings;
  shortcodesFolder?: string;

  tocLevels: number[];

  useFileMode: boolean;
  artifactLibrary: string;
  artifactLibraryFolder?: string;
  magicMarkdownWebPartId: string;
}

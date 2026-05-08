import { ArgumentsHelper, CliCommand, execScript, Logger } from "@helpers";
import { ListData } from "@models";

export class ListHelpers {
  private static pageList: ListData = null;

  /**
   * Retrieve the site pages library
   * @param webUrl
   */
  public static async getSitePagesList(webUrl: string) {
    if (!this.pageList) {
      let listData: any = await execScript(
        ArgumentsHelper.parse(
          `spo list list --webUrl "${webUrl}" --output json`
        ),
        CliCommand.getRetry()
      );
      if (listData && typeof listData === "string") {
        listData = JSON.parse(listData);
      }
      this.pageList = (listData as ListData[]).find((l) => {
        const url = l.Url || (l.RootFolder && l.RootFolder.ServerRelativeUrl) || "";
        return url.toLowerCase().includes("/sitepages");
      });
    }
    return this.pageList;
  }

  /**
   * Ensure a document library exists with NoCrawl enabled.
   * Creates the library if it doesn't exist, then sets NoCrawl = true
   * so the files are excluded from search/Copilot but still accessible via API.
   * Returns the library's root folder name (URL-safe, e.g. "SiteArtifacts")
   * which may differ from the display title (e.g. "Site Artifacts").
   */
  public static async ensureNoCrawlLibrary(
    webUrl: string,
    libraryTitle: string
  ): Promise<string> {
    let listData: ListData | null = null;

    try {
      let result: any = await execScript(
        ArgumentsHelper.parse(
          `spo list get --webUrl "${webUrl}" --title "${libraryTitle}" --output json`
        ),
        false
      );
      if (result && typeof result === "string") {
        result = JSON.parse(result);
      }
      listData = result as ListData;
    } catch (e) {
      // Library doesn't exist — create it
      // Create with no-space name first to get a clean URL, then rename to display title
      const urlSafeName = libraryTitle.replace(/\s/g, "");
      Logger.debug(`Library "${libraryTitle}" not found, creating as "${urlSafeName}"...`);
      await execScript(
        ArgumentsHelper.parse(
          `spo list add --webUrl "${webUrl}" --title "${urlSafeName}" --baseTemplate DocumentLibrary`
        ),
        CliCommand.getRetry()
      );

      // Rename to the display title (e.g. "PublishedContent" → "Published Content")
      if (urlSafeName !== libraryTitle) {
        Logger.debug(`Renaming library "${urlSafeName}" to "${libraryTitle}"`);
        await execScript(
          ArgumentsHelper.parse(
            `spo list set --webUrl "${webUrl}" --title "${urlSafeName}" --newTitle "${libraryTitle}"`
          ),
          CliCommand.getRetry()
        );
      }

      // Fetch the newly created library
      let result: any = await execScript(
        ArgumentsHelper.parse(
          `spo list get --webUrl "${webUrl}" --title "${libraryTitle}" --output json`
        ),
        CliCommand.getRetry()
      );
      if (result && typeof result === "string") {
        result = JSON.parse(result);
      }
      listData = result as ListData;
    }

    // Set NoCrawl if not already enabled
    if (!listData.NoCrawl) {
      Logger.debug(`Setting NoCrawl on "${libraryTitle}"`);
      await execScript(
        ArgumentsHelper.parse(
          `spo list set --webUrl "${webUrl}" --title "${libraryTitle}" --noCrawl true`
        ),
        CliCommand.getRetry()
      );
    }

    // Return the root folder name (URL-safe), e.g. "PublishedContent"
    let rootFolderName: string;
    if (listData.RootFolder && listData.RootFolder.Name) {
      rootFolderName = listData.RootFolder.Name;
    } else if (listData.RootFolder && listData.RootFolder.ServerRelativeUrl) {
      // ServerRelativeUrl is like "/sites/SiteName/PublishedContent" — take last segment
      rootFolderName = listData.RootFolder.ServerRelativeUrl.split("/").pop();
    } else if (listData.Url) {
      rootFolderName = listData.Url.split("/").pop();
    } else {
      rootFolderName = libraryTitle.replace(/\s/g, "");
    }
    Logger.debug(`Artifact library root folder: ${rootFolderName}`);
    return rootFolderName;
  }
}

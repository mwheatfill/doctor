import Listr = require("listr");
import kleur = require("kleur");
import { Authenticate } from "@commands";
import {
  DoctorTranspiler,
  FileHelpers,
  ListHelpers,
  Logger,
  MarkdownHelper,
  NavigationHelper,
  SiteHelpers,
  Cleanup,
  MultilingualHelper,
  StatusHelper,
} from "@helpers";
import { CommandArguments, PublishOutput } from "@models";
import { existsAsync } from "@utils";

export class Publish {
  /**
   * Publishes the markdown files to SharePoint
   * @param options
   */
  public static async start(options: CommandArguments) {
    Logger.debug(
      `Running with the following options: ${Logger.mask(
        JSON.stringify(options),
        [options.password, options.certificateBase64Encoded]
      )}`
    );

    if (!(await existsAsync(options.startFolder))) {
      return Promise.reject(
        new Error(`The provided folder location doesn't exist.`)
      );
    }

    if (!options.webUrl) {
      return Promise.reject(
        new Error(
          `In order to run the publish command, you need to specify the '--url' property.`
        )
      );
    }

    const { startFolder, webUrl } = options;

    let ouput: PublishOutput = {
      navigation: options.menu ? { ...options.menu } : null,
    };

    // Initializes the authentication
    await Authenticate.init(options);

    await new Listr([
      {
        title: `Clean up all the files`,
        task: async () => {
          // When cleanScope is set, only clean within that subfolder of sitepages
          const sitePagesFolder = options.cleanScope
            ? `sitepages/${options.cleanScope}`
            : "sitepages";
          await FileHelpers.cleanUp(options, sitePagesFolder);
          await FileHelpers.cleanUp(options, options.assetLibrary);
          if (options.useFileMode && options.artifactLibraryFolder) {
            const artifactFolder = options.cleanScope
              ? `${options.artifactLibraryFolder}/${options.cleanScope}`
              : options.artifactLibraryFolder;
            await FileHelpers.cleanUp(options, artifactFolder);
          }
        },
        enabled: () => options.cleanStart && options.confirm,
      },
      {
        title: `Ensure artifact library with NoCrawl`,
        task: async () => {
          const folderName = await ListHelpers.ensureNoCrawlLibrary(webUrl, options.artifactLibrary);
          options.artifactLibraryFolder = folderName;
          // In file mode, images go to the same NoCrawl library as markdown sources
          options.assetLibrary = folderName;
        },
        enabled: () => options.useFileMode,
      },
      {
        title: `Ensure SourceHash column on Site Pages`,
        task: async () => await ListHelpers.ensureSourceHashColumn(webUrl),
        enabled: () => !options.skipPages,
      },
      {
        title: `Multilingual site configuration`,
        task: async (ctx: any) => await MultilingualHelper.start(ctx, options),
        enabled: () => !!options.multilingual,
      },
      {
        title: `Fetch all markdown files`,
        task: async (ctx: any) =>
          await MarkdownHelper.fetchMDFiles(ctx, startFolder),
        enabled: () => !options.skipPages,
      },
      {
        title: `Process markdown files`,
        task: async (ctx: any) =>
          await DoctorTranspiler.processMDFiles(ctx, options, ouput),
        enabled: () => !options.skipPages,
      },
      {
        title: `Updating navigation`,
        task: async () =>
          await NavigationHelper.update(webUrl, ouput.navigation),
        enabled: () => !options.skipNavigation,
      },
      {
        title: `Change the look of the site`,
        task: async (ctx: any) => await SiteHelpers.changeLook(ctx, options),
        enabled: () => !!options.siteDesign && !options.skipSiteDesign,
      },
      {
        title: `Post cleanup`,
        task: async (ctx: any) => await Cleanup.start(ctx, options),
        enabled: () => options.cleanEnd && options.confirm,
      },
      {
        title: `Post cleanup: artifacts`,
        task: async () => await DoctorTranspiler.cleanArtifacts(
          webUrl,
          options.artifactLibraryFolder,
          options.cleanScope
        ),
        enabled: () => options.cleanEnd && options.confirm && options.useFileMode && !!options.artifactLibraryFolder,
      },
    ])
      .run()
      .catch((err) => {
        console.log("");
        console.log(
          kleur.bgRed().bold().white(` Command retries: `),
          kleur.bold().red(StatusHelper.getRetries())
        );
        throw err;
      });

    console.log("");
    console.info(kleur.bold().bgYellow().black(` Publishing stats `));
    console.info(kleur.white(` Pages: ${StatusHelper.getPages()}`));
    console.info(kleur.white(` Images: ${StatusHelper.getImages()}`));
    console.info(kleur.white(` Retries: ${StatusHelper.getRetries()}`));
  }
}

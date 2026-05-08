import { CheerioAPI, load, Element } from "cheerio";
import * as matter from "gray-matter";
import * as MarkdownIt from "markdown-it";
import {
  CommandArguments,
  PublishOutput,
  Control,
  PageFrontMatter,
} from "@models";
import {
  ArgumentsHelper,
  CliCommand,
  execScript,
  FileHelpers,
  FolderHelpers,
  FrontMatterHelper,
  HeaderHelper,
  Logger,
  MultilingualHelper,
  NavigationHelper,
  PagesHelper,
  StatusHelper,
} from "@helpers";
import { Observable, Subscriber } from "rxjs";
import { basename, join, dirname } from "path";
import { createHash } from "crypto";
import { existsAsync, mkdirAsync, readFileAsync, rmAsync, writeFileAsync } from "@utils";

export class DoctorTranspiler {
  private static converter = new MarkdownIt({ html: true, breaks: true });
  // Track all artifact URLs uploaded during this run (for cleanEnd orphan detection)
  private static uploadedArtifacts: Set<string> = new Set();

  /**
   * Process the retrieved Markdown files
   * @param ctx
   */
  public static async processMDFiles(
    ctx: any,
    options: CommandArguments,
    output: PublishOutput
  ): Promise<Observable<string>> {
    const { webUrl } = options;

    return new Observable((observer) => {
      (async () => {
        const { files } = ctx;

        await PagesHelper.getAllPages(webUrl);

        for (const file of files) {
          try {
            await this.processFile(file, observer, options, output);
          } catch (e) {
            observer.error(e);
            Logger.debug(e.message);

            if (!options.continueOnError) {
              throw e.message;
            }
          }
        }
        observer.complete();
      })();
    });
  }

  /**
   * Process page
   * @param file
   * @param observer
   * @param converter
   * @param options
   * @param output
   * @param languagePage
   */
  public static async processFile(
    file: string,
    observer: Subscriber<string>,
    options: CommandArguments,
    output: PublishOutput,
    languagePageSlug: string = null
  ) {
    const { webUrl, webPartTitle, skipExistingPages, disableComments } =
      options;

    if (file.endsWith(".md")) {
      const filename = basename(file);
      observer.next(`Started processing: ${filename}`);

      let contents = await readFileAsync(file, { encoding: "utf-8" });
      if (contents) {
        // Compute the source hash up front. SHA-256 of the full staged
        // file bytes (frontmatter + body, after collect.mjs's deterministic
        // wikilink/TOC processing). Used downstream to skip pages whose
        // content hasn't changed since last publish.
        const sourceHash = createHash("sha256").update(contents).digest("hex");

        const markup: matter.GrayMatterFile<string> = matter(contents);

        // Don't process language files, these will be processed later in the process
        if (
          !languagePageSlug &&
          markup.data &&
          markup.data.type === "translation"
        ) {
          return;
        }

        const htmlMarkup = file.endsWith(`.machinetranslated.md`)
          ? contents
          : this.converter.render(contents);

        const $ = load(htmlMarkup, {
          xmlMode: true,
          decodeEntities: false,
        });
        const imgElms = $(`img`).toArray();
        const anchorElms = $(`a`).toArray();

        // Check if the required data for the article is present
        if (markup && !markup.data) {
          throw new Error(`The "${filename}" has no front matter defined`);
        } else if (markup && markup.data) {
          if (!markup.data.title) {
            throw new Error(`The "${filename}" has no 'title' defined`);
          }
        }

        let { title, description, draft, layout, header, template, metadata } =
          markup.data as PageFrontMatter;
        const { showToc, tocTitle, tocDepth, tocCollapsible } =
          markup.data as PageFrontMatter;
        const tocOverrides = { showToc, tocTitle, tocDepth, tocCollapsible };
        let slug =
          languagePageSlug ||
          FrontMatterHelper.getSlug(
            markup.data as PageFrontMatter,
            options.startFolder,
            file
          );

        // Skip-if-unchanged: if an existing page has a SourceHash that
        // matches the current source content, skip the entire per-page
        // pipeline (header set, markdown upload, web part insert, metadata,
        // publish, description). The --force flag bypasses this check.
        // Translations always process to keep multilingual sync consistent.
        if (!options.force && !languagePageSlug) {
          const existingPage = PagesHelper.findPageBySlug(webUrl, slug);
          if (
            existingPage &&
            existingPage.SourceHash &&
            existingPage.SourceHash === sourceHash
          ) {
            Logger.debug(
              `Hash match for ${filename} (${sourceHash.slice(0, 12)}…) — skipping`
            );
            observer.next(`Skipped (unchanged): ${filename}`);
            // Mark the page as processed so cleanEnd doesn't sweep it
            // (getUntouchedPages uses processedPages, not source presence).
            if (existingPage.ID) {
              PagesHelper.markProcessed(slug, existingPage.ID);
            }
            // Track the artifact URL too so cleanEnd skips the .md source.
            const artifactUrl = this.predictArtifactUrl(file, options);
            if (artifactUrl) {
              this.uploadedArtifacts.add(artifactUrl.toLowerCase());
            }
            return;
          }
          if (existingPage && existingPage.SourceHash) {
            Logger.debug(
              `Hash mismatch for ${filename}: ${existingPage.SourceHash.slice(0, 12)}… → ${sourceHash.slice(0, 12)}…`
            );
          }
        }

        // Auto-populate topicHeader from ArtifactType metadata when not explicitly set
        if (metadata && metadata.ArtifactType && (!header || !header.topicHeader)) {
          if (!header) {
            header = {};
          }
          header.showTopicHeader = true;
          header.topicHeader = metadata.ArtifactType;
        }

        // Map friendly author email to Author0 claims format and header.authors
        if (metadata && metadata.author) {
          const email = metadata.author;
          metadata.Author0 = `[{'Key':'i:0#.f|membership|${email}'}]`;
          delete metadata.author;
          if (!header) {
            header = {};
          }
          if (!header.authors) {
            header.authors = [email];
          }
        }

        // Check if comments are disabled on global level, or overwrite it from page level
        const disablePageComments =
          typeof markup.data.comments !== "undefined"
            ? !markup.data.comments
            : disableComments;
        Logger.debug(
          `Page comments ${disablePageComments ? "disabled" : "enabled"}`
        );

        // Image processing
        if (imgElms && imgElms.length > 0) {
          observer.next(`Uploading images referenced in ${filename}`);

          markup.content = await this.processImages(
            $,
            imgElms,
            file,
            markup.content,
            options,
            output
          );
        }

        // Anchor processing
        if (anchorElms && anchorElms.length > 0) {
          observer.next(`Processing links in ${filename}`);

          Logger.debug(`Number of links in ${filename}: ${anchorElms.length}`);

          try {
            markup.content = await this.processLinks(
              $,
              anchorElms,
              file,
              markup.content,
              options
            );
          } catch (e) {
            throw e.message;
          }
        }

        // Checks if output needs to be generated
        if (options.outputFolder) {
          const { outputFolder, startFolder } = options;
          const processedFilePath = file.replace(
            startFolder,
            join(process.cwd(), outputFolder)
          );
          const dirPath = dirname(processedFilePath);
          await mkdirAsync(dirPath, { recursive: true });
          await writeFileAsync(processedFilePath, markup.content, {
            encoding: "utf-8",
          });
        }

        if (markup && markup.content) {
          observer.next(
            `Creating or updating the page in SharePoint for ${filename}`
          );

          // Check if the page already exists
          const existed = await PagesHelper.createPageIfNotExists(
            webUrl,
            slug,
            title,
            layout,
            disablePageComments,
            description,
            template || options.pageTemplate,
            skipExistingPages && !languagePageSlug
          );

          Logger.debug(
            `Page existed: ${existed} - Skipping existing pages: ${skipExistingPages}`
          );

          if (
            !existed ||
            (existed && !skipExistingPages) ||
            (existed && languagePageSlug)
          ) {
            // Check if the header of the page needs to be changed
            await HeaderHelper.set(
              file,
              webUrl,
              slug,
              header,
              options,
              !!(template || options.pageTemplate)
            );

            // Retrieving all the controls from the page, so that we can start replacing the
            const controlData: string = await PagesHelper.getPageControls(
              webUrl,
              slug
            );
            if (controlData) {
              const webparts: Control[] = JSON.parse(controlData);
              const markdownWp: Control = webparts.find(
                (c: Control) =>
                  c.webPartData && c.webPartData.title === webPartTitle
              );

              if (options.useFileMode) {
                // Magic Markdown file URL mode: upload .md to SiteArtifacts, then
                // insert web part with fileUrl + searchableContent for Copilot/search
                observer.next(`Uploading markdown source for ${filename}`);

                const artifactFileUrl = await this.uploadMarkdownArtifact(
                  file,
                  markup.content,
                  options
                );

                await PagesHelper.insertOrCreateMagicMarkdownControl(
                  webPartTitle,
                  artifactFileUrl,
                  markup.content,
                  slug,
                  webUrl,
                  options,
                  markdownWp ? markdownWp.id : null,
                  tocOverrides
                );
              } else {
                await PagesHelper.insertOrCreateControl(
                  webPartTitle,
                  markup.content,
                  slug,
                  webUrl,
                  options,
                  markdownWp ? markdownWp.id : null,
                  options.markdown,
                  file.endsWith(`.machinetranslated.md`)
                );
              }
            }

            // Always set page metadata after a successful publish, with
            // SourceHash merged in. This means subsequent runs can compare
            // content hashes and skip unchanged pages. Translations are
            // excluded — they're tracked under their language slug.
            const finalMetadata: { [k: string]: any } = { ...(metadata || {}) };
            if (!languagePageSlug) {
              finalMetadata.SourceHash = sourceHash;
            }
            if (Object.keys(finalMetadata).length > 0) {
              await PagesHelper.setPageMetadata(webUrl, slug, finalMetadata);
            }

            // Check if page needs to be published
            if (typeof draft === "undefined" || !draft) {
              observer.next(`Publishing ${filename}`);
              await PagesHelper.publishPageIfNeeded(webUrl, slug);
            }

            // Set the page its description
            if (description) {
              observer.next(`Setting page description for ${filename}`);
              await PagesHelper.setPageDescription(webUrl, slug, description);
            }

            StatusHelper.addPage();
          } else {
            Logger.debug(`Skipping "${filename}" as it already exists`);
          }
        }

        // Check if the file contains a menu element to add too and if not in draft status (cannot add draft pages to navigation)
        if (
          output.navigation &&
          markup &&
          markup.data &&
          markup.data.menu &&
          !markup.data.draft
        ) {
          Logger.debug(
            `Adding item to the navigation: ${slug} - ${title} - ${JSON.stringify(
              markup.data.menu
            )} `
          );

          output.navigation = NavigationHelper.hierarchy(
            webUrl,
            output.navigation,
            markup.data.menu,
            slug,
            title
          );
        }

        // Verify if there are linked multilingual pages
        if (
          !languagePageSlug &&
          options.multilingual &&
          options.multilingual.enableTranslations &&
          markup &&
          markup.data &&
          markup.data.localization
        ) {
          await MultilingualHelper.linkPage(
            markup.data.localization,
            file,
            slug,
            options,
            observer,
            output
          );
        }
      }
    }
  }

  /**
   * Compute the server-relative URL the markdown source would have if
   * it were uploaded — without making any network calls. Mirrors
   * uploadMarkdownArtifact's URL construction. Used by the skip-if-unchanged
   * path to keep already-published artifacts out of cleanEnd's orphan sweep.
   */
  private static predictArtifactUrl(
    filePath: string,
    options: CommandArguments
  ): string | null {
    const { startFolder, artifactLibraryFolder, webUrl } = options;
    if (!options.useFileMode) return null;
    const artifactLibrary = artifactLibraryFolder || "PublishedContent";
    const uniStartPath = startFolder.replace(/\\/g, "/");
    const uniFilePath = filePath.replace(/\\/g, "/");
    const relativePath = uniFilePath.replace(uniStartPath, "");
    const allFolders = dirname(relativePath).split("/").filter((s) => s);
    const topFolder = allFolders.length > 0 ? allFolders[0] : "";
    const crntFolder = topFolder
      ? `${artifactLibrary}/${topFolder}`
      : artifactLibrary;
    const relWebUrl = webUrl.split("sharepoint.com").pop();
    return `${relWebUrl}/${crntFolder}/${basename(filePath)}`.replace(
      / /g,
      "%20"
    );
  }

  /**
   * Upload the markdown file to the artifact library, flattened into
   * a single folder matching the page slug prefix (e.g. PublishedContent/artifacts/).
   * Returns the server-relative file URL.
   */
  private static async uploadMarkdownArtifact(
    filePath: string,
    content: string,
    options: CommandArguments
  ): Promise<string> {
    const { startFolder, artifactLibraryFolder, webUrl } = options;
    const artifactLibrary = artifactLibraryFolder || "PublishedContent";

    // Use only the first subfolder from the relative path (e.g. "artifacts")
    // to keep all markdown files flat: PublishedContent/artifacts/
    const uniStartPath = startFolder.replace(/\\/g, "/");
    const uniFilePath = filePath.replace(/\\/g, "/");
    const relativePath = uniFilePath.replace(uniStartPath, "");
    const allFolders = dirname(relativePath).split("/").filter((s) => s);
    const topFolder = allFolders.length > 0 ? [allFolders[0]] : [];

    let crntFolder = artifactLibrary;
    if (topFolder.length > 0) {
      crntFolder = await FolderHelpers.create(crntFolder, topFolder, webUrl);
    }

    // Write the processed markdown content to a temp file for upload
    const tempFilePath = join(
      process.cwd(),
      "temp",
      basename(filePath)
    );
    await mkdirAsync(dirname(tempFilePath), { recursive: true });
    await writeFileAsync(tempFilePath, content, { encoding: "utf-8" });

    // Upload with overwrite (content may have changed)
    await FileHelpers.create(crntFolder, tempFilePath, webUrl, true);

    // Clean up temp file
    try {
      await rmAsync(tempFilePath);
    } catch (e) {
      // Best-effort cleanup
    }

    // Return the server-relative URL to the uploaded file
    const relWebUrl = webUrl.split("sharepoint.com").pop();
    const artifactUrl = `${relWebUrl}/${crntFolder}/${basename(filePath)}`.replace(/ /g, "%20");
    this.uploadedArtifacts.add(artifactUrl.toLowerCase());
    return artifactUrl;
  }

  /**
   * Clean up artifact files in Published Content that were not uploaded
   * during this publish run. Mirrors PagesHelper.clean() for pages.
   */
  public static async cleanArtifacts(
    webUrl: string,
    artifactLibraryFolder: string,
    cleanScope: string
  ): Promise<Observable<string>> {
    return new Observable((observer) => {
      (async () => {
        // List all files in the artifact library recursively
        let filesData: any = await execScript<string>(
          ArgumentsHelper.parse(
            `spo file list --webUrl "${webUrl}" --folderUrl "/${artifactLibraryFolder}" --recursive -o json`
          ),
          CliCommand.getRetry()
        );
        if (filesData && typeof filesData === "string") {
          filesData = JSON.parse(filesData);
        }

        const relWebUrl = webUrl.split("sharepoint.com").pop();
        const allFiles = (filesData || []).filter(
          (f: any) => f.ServerRelativeUrl && !f.ServerRelativeUrl.includes("/Forms/")
        );

        Logger.debug(`Uploaded artifacts this run: ${[...this.uploadedArtifacts]}`);

        for (const file of allFiles) {
          const fileUrl: string = file.ServerRelativeUrl.toLowerCase();

          // Scope to cleanScope folder if configured (e.g. "artifacts")
          if (cleanScope) {
            const scope = cleanScope.toLowerCase().replace(/^\/+/, "").replace(/\/+$/, "");
            const relPath = fileUrl.split(`/${artifactLibraryFolder.toLowerCase()}/`).pop() || "";
            if (!relPath.startsWith(`${scope}/`)) {
              continue;
            }
          }

          // Skip files that were uploaded during this run
          if (this.uploadedArtifacts.has(fileUrl)) {
            continue;
          }

          // Also check with the relWebUrl prefix form
          const altUrl = `${relWebUrl}/${artifactLibraryFolder}/${fileUrl.split(`/${artifactLibraryFolder.toLowerCase()}/`).pop()}`.toLowerCase();
          if (this.uploadedArtifacts.has(altUrl)) {
            continue;
          }

          try {
            Logger.debug(`Cleaning up artifact: ${file.ServerRelativeUrl}`);
            observer.next(`Cleaning up artifact: ${file.ServerRelativeUrl}`);
            await execScript<string>(
              ArgumentsHelper.parse(
                `spo file remove --webUrl "${webUrl}" --url "${file.ServerRelativeUrl}" --force`
              ),
              CliCommand.getRetry()
            );
          } catch (e) {
            Logger.debug(`Failed to remove artifact: ${e.message}`);
          }
        }

        observer.complete();
      })();
    });
  }

  /**
   * Process images referenced in the file
   * @param $
   * @param imgElms
   * @param filePath
   * @param contents
   * @param options
   * @param output
   */
  private static async processImages(
    $: CheerioAPI,
    imgElms: Element[],
    filePath: string,
    contents: string,
    options: CommandArguments,
    output: PublishOutput
  ) {
    const { startFolder, assetLibrary, webUrl, overwriteImages } = options;

    const imgSources = imgElms
      .filter((i) => !$(i).attr("src").startsWith(`http`))
      .map((img) => $(img).attr("src"));
    const uImgSources = [...new Set(imgSources)];

    for (const imgSource of uImgSources) {
      Logger.debug(`Adding image: ${imgSource} - ${imgSources.length}`);

      const imgDirectory = join(dirname(filePath), dirname(imgSource));
      const imgPath = join(dirname(filePath), imgSource);

      const uniStartPath = startFolder.replace(/\\/g, "/");
      let folders = imgDirectory
        .replace(/\\/g, "/")
        .replace(uniStartPath, "")
        .split("/")
        .filter((s) => s);

      // In file mode, flatten to [topFolder, "assets"] (e.g. artifacts/assets)
      if (options.useFileMode && folders.length > 0) {
        folders = [folders[0], "assets"];
      }

      let crntFolder = assetLibrary;

      // Start folder creation process
      crntFolder = await FolderHelpers.create(crntFolder, folders, webUrl);

      try {
        const imgUrl = await FileHelpers.create(
          crntFolder,
          imgPath,
          webUrl,
          overwriteImages
        );
        contents = contents.replace(new RegExp(imgSource, "g"), imgUrl);
        StatusHelper.addImage();
        // Track for artifact cleanup (normalize to server-relative URL)
        if (options.useFileMode && imgUrl) {
          let normalizedUrl = imgUrl;
          if (normalizedUrl.includes("sharepoint.com")) {
            normalizedUrl = normalizedUrl.split("sharepoint.com").pop();
          }
          this.uploadedArtifacts.add(normalizedUrl.toLowerCase());
        }
      } catch (e) {
        return Promise.reject(
          new Error(
            `Something failed while uploading the image asset. ${e.message}`
          )
        );
      }
    }

    return contents;
  }

  /**
   * Process the links referenced in the markdown files
   * @param $
   * @param linkElms
   * @param filePath
   * @param content
   * @param options
   */
  private static async processLinks(
    $: CheerioAPI,
    linkElms: Element[],
    filePath: string,
    content: string,
    options: CommandArguments
  ): Promise<string> {
    const { webUrl, startFolder } = options;

    const fLinks = linkElms.filter(
      (i) => !$(i).attr("href").startsWith(`http`)
    );
    const uLinks = [...new Set(fLinks)];

    for (const link of uLinks) {
      const $link = $(link);
      const fileLink = $link.attr("href");
      let mdFile = "";

      Logger.debug(`Processing link: ${fileLink} for ${filePath}`);

      if (fileLink.endsWith(`.md`)) {
        mdFile = $link.attr("href");
      } else if (fileLink === ".") {
        mdFile = basename(filePath);
      } else {
        mdFile = `${$link.attr("href")}.md`;
      }

      const mdFilePath = join(dirname(filePath), mdFile);

      Logger.debug(`File path for link: ${mdFilePath}`);

      if (await existsAsync(mdFilePath)) {
        // Get the contents of the file
        const mdContents = await readFileAsync(mdFilePath, {
          encoding: "utf-8",
        });
        if (!mdContents) {
          return;
        }

        // Get the slug
        const mdData = matter(mdContents);
        if (!mdData || !mdData.data) {
          return;
        }

        const slug = FrontMatterHelper.getSlug(
          mdData.data as PageFrontMatter,
          startFolder,
          mdFilePath
        );
        const spUrl = `${webUrl}${
          webUrl.endsWith("/") ? "" : "/"
        }sitepages/${slug}`;
        Logger.debug(`Referenced file slug: ${spUrl}`);

        // Update the link in the markdown
        content = content.replace(`(${fileLink})`, `(${spUrl})`);
        content = content.replace(`"${fileLink}"`, `"${spUrl}"`);
        content = content.replace(`'${fileLink}`, `'${spUrl}'`);
      } else {
        Logger.debug(`Referenced file not found`);
      }
    }

    return content;
  }
}

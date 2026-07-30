import { Command } from "commander"
import { promises as fsPromises } from "node:fs"
import http from "node:http"
import path from "node:path"
import { remote, type Browser } from "webdriverio"

import { WORKER_CHROME_EXTRA_ARGS, WORKER_ENABLE_WEBGL } from "../environment"
import { log } from "../log"
import { hardenedChromeArgs } from "../safeguards"
import { startStaticServer } from "../server"
import {
  captureStableScreenshot,
  getStoryViewport,
  getStorybookStories,
  navigateToStorybook,
} from "../stories"
import { installStoryRenderStateHook } from "../storyReady"
import type { Story } from "../types"
import { nodeCompatTransformRequest } from "../wdio"

interface CliOptions {
  storybookDir: string
  outputDir: string
}

async function main(options: CliOptions) {
  const storybookDir = path.resolve(options.storybookDir)
  const outputDir = path.resolve(options.outputDir)

  log.info(`Starting local screenshot generation`)
  log.info(`Storybook directory: ${storybookDir}`)
  log.info(`Output directory: ${outputDir}`)

  // 1. Validate inputs
  try {
    await fsPromises.access(storybookDir)
  } catch (err) {
    log.error(err, `Invalid storybook directory: ${storybookDir}. Make sure it exists.`)
    process.exit(1)
  }
  await fsPromises.mkdir(outputDir, { recursive: true })

  // 2. Start local web server using the utility
  let server: http.Server | undefined
  let port: number | undefined
  try {
    ;({ server, port } = await startStaticServer(storybookDir))
  } catch (err) {
    log.error(err, "Failed to start local static server")
    process.exit(1)
  }

  // 4. Initialize WebDriverIO
  let browser: Browser | undefined
  try {
    log.info("Initializing WebDriverIO...")
    browser = await remote({
      hostname: "localhost",
      capabilities: {
        browserName: "chrome",
        // Enable WebDriver BiDi so the story render-state hook (issue #458) can be
        // installed via `addInitScript`, matching the real ingest path.
        webSocketUrl: true,
        "goog:chromeOptions": {
          // Same launch args as the real ingest path (safeguards.ts), including
          // opt-in WebGL and extra args, so local screenshots match production
          // rendering.
          args: hardenedChromeArgs(
            ["--headless", "--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
            { enableWebgl: WORKER_ENABLE_WEBGL, extraArgs: WORKER_CHROME_EXTRA_ARGS },
          ),
        },
      },
      logLevel: "warn",
      transformRequest: nodeCompatTransformRequest,
    })
    log.info("WebDriverIO initialized.")

    // Record Storybook's story-render lifecycle in the page (issue #458) so capture waits for
    // render completion, matching the real ingest path.
    await installStoryRenderStateHook(browser)

    // Set initial viewport
    await browser.setViewport({ width: 1200, height: 900, devicePixelRatio: 1 })

    // Navigate to the Storybook iframe and wait for stories to load
    await navigateToStorybook(browser, port)

    // Fetch stories from running Storybook instance
    let stories: Record<string, Story>
    try {
      log.info("Fetching stories from Storybook preview...")
      stories = await getStorybookStories(browser)
      log.info(`Found ${Object.keys(stories).length} stories in Storybook.`)
    } catch (err) {
      log.error(err, "Failed to fetch stories from Storybook")
      process.exit(1)
    }

    // 5. Process stories
    let successCount = 0
    let errorCount = 0
    const storyIds = Object.keys(stories)
    const tempDir = path.join(outputDir, ".tmp-screenshots") // Temp dir for stabilization images
    await fsPromises.mkdir(tempDir, { recursive: true })

    for (const storyId of storyIds) {
      const story = stories[storyId]
      // Add null/undefined check for story
      if (!story) {
        log.error(`Story with id ${storyId} not found in fetched stories, skipping.`)
        errorCount++
        continue
      }

      const viewport = getStoryViewport(story)

      // Construct a readable name like the worker does
      const cleanedTitle = story.title.startsWith("stories/") ? story.title.slice(8) : story.title
      const storyName = `${cleanedTitle}/${story.name}`.slice(-255)
      log.info(`Processing story: ${storyId} (${storyName})`)

      const outputFilePath = path.join(outputDir, `${storyId}.png`)

      try {
        // Call the refactored screenshot function
        await captureStableScreenshot(browser, story, viewport, port, tempDir, outputFilePath)

        log.info(`Screenshot saved to ${outputFilePath}`)
        successCount++
      } catch (err) {
        log.error(err, `Failed to process story ${storyId} (${storyName})`)
        errorCount++
      }
    }

    // Clean up temp directory
    await fsPromises.rm(tempDir, { recursive: true, force: true })

    log.info(`Finished processing ${storyIds.length} stories.`)
    log.info(`Success: ${successCount}, Errors: ${errorCount}`)
  } catch (err) {
    log.error(err, "An error occurred during screenshot generation")
  } finally {
    // 6. Cleanup
    log.info("Cleaning up...")
    if (browser) {
      try {
        await browser.deleteSession()
        log.info("WebDriverIO session deleted.")
      } catch (cleanupErr) {
        log.error(cleanupErr, "Error deleting WebDriverIO session")
      }
    }
    server.close(() => {
      log.info("Local web server stopped.")
    })
  }
}

const program = new Command()
program
  .name("screenshot")
  .description("Generate screenshots for a local storybook-static directory")
  .requiredOption("-s, --storybook-dir <path>", "Path to the storybook-static directory")
  .requiredOption("-o, --output-dir <path>", "Path to the output directory for screenshots")
  .action(main)

program.parse(process.argv)

import { createAppAuth } from "@octokit/auth-app"
import { Octokit } from "@octokit/rest"

import {
  GITHUB_APP_ID,
  GITHUB_CLIENT_ID,
  GITHUB_CLIENT_SECRET,
  GITHUB_PRIVATE_KEY,
} from "../environment"
import { getInstallationForOrg, getInstallationsForUserId, syncUserInstallations } from "../github"
import { log } from "../log"
import type { RequestHandler } from "../types"

const GITHUB_HEADERS = { "X-GitHub-Api-Version": "2022-11-28" }

async function getOctokitForUser(installationId: number): Promise<Octokit> {
  const auth = createAppAuth({
    appId: GITHUB_APP_ID,
    privateKey: GITHUB_PRIVATE_KEY,
    clientId: GITHUB_CLIENT_ID,
    clientSecret: GITHUB_CLIENT_SECRET,
  })
  const installationAuth = await auth({ type: "installation", installationId })
  return new Octokit({ auth: installationAuth.token })
}

export const orgs: RequestHandler = async (_req, res) => {
  const { user } = res.locals

  // Ensure installations are up to date
  const installations = await syncUserInstallations(user)
  if (installations.length === 0) {
    res.status(403).json({ error: "GitHub App installation required for this endpoint" })
    return
  }

  log.debug(
    `Found installations: ${installations
      .map((i) => `${i.accountName}(${i.accountType})`)
      .join(", ")}`,
  )

  // Get all org installations
  const orgInstallations = installations.filter((inst) => inst.accountType === "Organization")

  // Convert installations to org format
  const ORGS_URL = "https://api.github.com/user/orgs"
  const orgList = orgInstallations.map((inst) => ({
    login: inst.accountName,
    id: parseInt(inst.accountId, 10),
    node_id: "", // We don't have this but it's not used
    url: `${ORGS_URL}/${inst.accountName}`,
    repos_url: `${ORGS_URL}/${inst.accountName}/repos`,
    events_url: `${ORGS_URL}/${inst.accountName}/events`,
    hooks_url: `${ORGS_URL}/${inst.accountName}/hooks`,
    issues_url: `${ORGS_URL}/${inst.accountName}/issues`,
    members_url: `${ORGS_URL}/${inst.accountName}/members{/member}`,
    public_members_url: `${ORGS_URL}/${inst.accountName}/public_members{/member}`,
    avatar_url: `https://avatars.githubusercontent.com/u/${inst.accountId}?v=4`,
    description: null,
  }))

  log.debug(
    `Found ${orgList.length} GitHub orgs with app installations for ${user.githubUsername}. ` +
      `Organizations: ${orgList.map((o) => o.login).join(", ")}`,
  )
  res.json(orgList)
}

export const repos: RequestHandler = async (req, res) => {
  const { user } = res.locals
  const org = req.query.org as string | undefined

  // Ensure installations are up to date
  await syncUserInstallations(user)

  const installation = org
    ? await getInstallationForOrg(user.id, org)
    : (await getInstallationsForUserId(user.id)).find((i) => i.accountType === "User")

  if (!installation) {
    res.status(403).json({ error: "GitHub App installation required for this endpoint" })
    return
  }

  const octokit = await getOctokitForUser(installation.installationId)
  const ghRes = org
    ? await octokit.request("GET /orgs/{org}/repos", {
        headers: GITHUB_HEADERS,
        sort: "pushed",
        type: "all",
        org,
        per_page: 100,
      })
    : await octokit.request("GET /user/repos", {
        headers: GITHUB_HEADERS,
        sort: "pushed",
        affiliation: "owner,collaborator",
        per_page: 100,
      })

  // Repos that already have a VizDiff project are intentionally NOT filtered out: a monorepo can
  // host multiple VizDiff projects (one per Storybook, distinguished by `key`; issue #443).

  log.info(
    {
      userId: user.id,
      org,
      totalReposLength: ghRes.data.length,
    },
    "Returning GitHub projects",
  )
  res.json(ghRes.data)
}

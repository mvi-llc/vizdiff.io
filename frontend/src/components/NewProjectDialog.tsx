import CloseIcon from "@mui/icons-material/Close"
import GitHubIcon from "@mui/icons-material/GitHub"
import RefreshIcon from "@mui/icons-material/Refresh"
import {
  Alert,
  Box,
  Button,
  CircularProgress,
  Dialog,
  DialogContent,
  DialogTitle,
  IconButton,
  List,
  ListItemButton,
  ListItemText,
  Tabs,
  Tab,
  TextField,
  Typography,
} from "@mui/material"
import type { Endpoints } from "@octokit/types"
import React, { type JSX, useState, useEffect, useCallback } from "react"

import { GitLabIcon } from "@/components/GitLabIcon"
import useAuthenticatedFetch from "@/hooks/useApiGet"
import { apiGet, apiPost } from "@/lib/apiMethods"
import { GITHUB_APP_NAME, GITHUB_ENABLED } from "@/lib/environment"

type NewProjectDialogProps = {
  onClose: () => void
  initialSelectedOrg?: string
  mode?: "light" | "dark"
}

type VCSProvider = "github" | "gitlab"

type GithubOrg = Endpoints["GET /user/orgs"]["response"]["data"][0]
type GithubRepo = Endpoints["GET /orgs/{org}/repos"]["response"]["data"][0]

type GitLabGroup = {
  id: number
  login: string // full_path
  name: string
  path: string
  full_path: string
  web_url: string
  avatar_url: string | null
}

type GitLabProject = {
  id: number
  name: string
  path: string
  path_with_namespace: string
  web_url: string
  visibility: string
  namespace: {
    id: number
    name: string
    path: string
    kind: string
    full_path: string
  }
}

const API_GITHUB_ORGS_URL = "/api/github/orgs"
const API_GITHUB_REPOS_URL = "/api/github/repos"
const API_GITLAB_GROUPS_URL = "/api/gitlab/groups"
const API_GITLAB_PROJECTS_URL = "/api/gitlab/projects"

export default function NewProjectDialog({
  onClose,
  initialSelectedOrg,
  mode,
}: NewProjectDialogProps): JSX.Element {
  void mode
  // GitHub is the default provider when enabled in this deployment; otherwise GitLab (the
  // only provider available in self-hosted deployments without the GitHub integration).
  const [provider, setProvider] = useState<VCSProvider>(GITHUB_ENABLED ? "github" : "gitlab")
  const [githubRepos, setGithubRepos] = useState<GithubRepo[]>([])
  const [gitlabProjects, setGitlabProjects] = useState<GitLabProject[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [_selectedOrg, setSelectedOrg] = useState<string | undefined>(initialSelectedOrg)
  const [reposLoading, setReposLoading] = useState(false)
  const [refreshCounter, setRefreshCounter] = useState(0)
  const [loadingStartTime, setLoadingStartTime] = useState<number | null>(null)
  // Optional monorepo discriminator: allows adding several projects (one per Storybook) for the
  // same repository. Left empty for the common single-project case.
  const [projectKey, setProjectKey] = useState("")

  const [githubOrgs, isGithubOrgsLoading, _githubOrgsErr] = useAuthenticatedFetch<GithubOrg[]>(
    provider === "github" ? API_GITHUB_ORGS_URL + `?refresh=${refreshCounter}` : undefined,
  )

  const [gitlabGroups, isGitlabGroupsLoading, _gitlabGroupsErr] = useAuthenticatedFetch<
    GitLabGroup[]
  >(provider === "gitlab" ? API_GITLAB_GROUPS_URL + `?refresh=${refreshCounter}` : undefined)

  const orgs = provider === "github" ? githubOrgs : gitlabGroups
  const isOrgsLoading = provider === "github" ? isGithubOrgsLoading : isGitlabGroupsLoading

  useEffect(() => {
    if (isOrgsLoading && loadingStartTime == null) {
      setLoadingStartTime(Date.now())
    } else if (!isOrgsLoading && loadingStartTime != null) {
      const elapsedTime = Date.now() - loadingStartTime
      if (elapsedTime < MIN_LOADING_TIME) {
        const timeout = setTimeout(() => {
          setLoadingStartTime(null)
        }, MIN_LOADING_TIME - elapsedTime)
        return () => clearTimeout(timeout)
      }
      setLoadingStartTime(null)
    }
    return undefined
  }, [isOrgsLoading, loadingStartTime])

  const updateLoading = useCallback(() => {
    if (!isOrgsLoading && loadingStartTime == null) {
      setLoading(false)
    }
  }, [isOrgsLoading, loadingStartTime])

  const handleOrgClick = useCallback(
    async (org: string, groupId?: number) => {
      setReposLoading(true)
      const loadStart = Date.now()

      if (provider === "github") {
        const [orgRepos, _orgReposError] = await apiGet(`${API_GITHUB_REPOS_URL}?org=${org}`)
        setGithubRepos((orgRepos as [] | null) ?? [])
        setGitlabProjects([])
      } else {
        // GitLab: fetch projects for the selected group
        const url = groupId
          ? `${API_GITLAB_PROJECTS_URL}?group=${groupId}`
          : API_GITLAB_PROJECTS_URL
        const [groupProjects, _groupProjectsError] = await apiGet(url)
        setGitlabProjects((groupProjects as [] | null) ?? [])
        setGithubRepos([])
      }
      setSelectedOrg(org)

      const elapsedTime = Date.now() - loadStart
      if (elapsedTime < MIN_LOADING_TIME) {
        await new Promise((resolve) => setTimeout(resolve, MIN_LOADING_TIME - elapsedTime))
      }
      setReposLoading(false)
    },
    [provider],
  )

  useEffect(() => updateLoading(), [updateLoading])

  // Fetch repos for initialSelectedOrg when orgs are loaded
  useEffect(() => {
    if (initialSelectedOrg && orgs && orgs.length > 0 && !isOrgsLoading && provider === "github") {
      void handleOrgClick(initialSelectedOrg)
    }
  }, [initialSelectedOrg, orgs, isOrgsLoading, provider, handleOrgClick])

  const handleRefresh = useCallback(() => {
    setLoading(true)
    setError(null)
    setReposLoading(false)
    setGithubRepos([])
    setGitlabProjects([])
    setSelectedOrg(undefined)
    setLoadingStartTime(Date.now())
    setRefreshCounter((prev) => prev + 1)
  }, [])

  const handleProviderChange = (_event: React.SyntheticEvent, newProvider: VCSProvider) => {
    setProvider(newProvider)
    setError(null)
    setGithubRepos([])
    setGitlabProjects([])
    setSelectedOrg(undefined)
    setReposLoading(false)
    setLoadingStartTime(Date.now())
    setRefreshCounter((prev) => prev + 1)
  }

  const handleRepoClick = async (repo: GithubRepo | GitLabProject) => {
    setLoading(true)
    setError(null)
    setLoadingStartTime(Date.now())

    let projectData: Record<string, unknown>
    let label: string
    let isPrivate: boolean

    const key = projectKey.trim()
    if (provider === "github") {
      const githubRepo = repo as GithubRepo
      projectData = {
        name: key ? `${githubRepo.name} (${key})` : githubRepo.name,
        vcsProvider: "github",
        repoId: githubRepo.id,
        repoUrl: githubRepo.html_url,
      }
      label = githubRepo.private ? `(private)` : githubRepo.full_name
      isPrivate = githubRepo.private || false
    } else {
      const gitlabProject = repo as GitLabProject
      projectData = {
        name: key ? `${gitlabProject.name} (${key})` : gitlabProject.name,
        vcsProvider: "gitlab",
        repoId: gitlabProject.id,
        repoUrl: gitlabProject.web_url,
      }
      label = gitlabProject.path_with_namespace
      isPrivate = gitlabProject.visibility !== "public"
    }
    if (key) {
      projectData.key = key
    }

    // Create the project
    const [_project, projectError] = await apiPost("/api/projects", projectData)
    void label
    void isPrivate
    if (projectError) {
      // Keep the dialog open and surface the error so the user can retry
      setError(projectError.message)
      setLoading(false)
      setLoadingStartTime(null)
      return
    }
    updateLoading()
    onClose()
  }

  const handleInstallApp = () => {
    const installUrl = `https://github.com/apps/${GITHUB_APP_NAME}/installations/new`
    window.open(installUrl, "_blank")
  }

  // Define a minimum loading time (in ms) to ensure loading states are visible
  const MIN_LOADING_TIME = 300

  return (
    <Dialog
      open={true}
      onClose={onClose}
      maxWidth="md"
      fullWidth
      slotProps={{
        paper: {
          sx: {
            margin: 0,
            width: { xs: "96.5%", md: "calc(100% - 32px)" },
            minHeight: "50vh",
            maxHeight: "80vh",
            fontSize: { xs: "0.875rem", sm: "1rem" },
          },
        },
      }}
    >
      <DialogTitle
        sx={{
          display: "flex",
          flexDirection: "column",
          gap: 2,
          fontSize: { xs: "1.1rem", sm: "1.25rem" },
          px: { xs: 1.5, sm: 3 },
          pb: 2,
        }}
      >
        <Box sx={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <Box component="span">Add Repository</Box>
          <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
            {provider === "github" &&
              !isOrgsLoading &&
              !loading &&
              loadingStartTime == null &&
              orgs &&
              orgs.length > 0 && (
                <Button
                  size="small"
                  variant="outlined"
                  onClick={handleInstallApp}
                  startIcon={<GitHubIcon />}
                  sx={{
                    height: "32px",
                    textTransform: "none",
                    color: "black",
                    borderColor: "rgba(0, 0, 0, 0.23)",
                    whiteSpace: "nowrap",
                    overflow: "hidden",
                    "& .MuiButton-icon": {
                      margin: { xs: 0, sm: 1 },
                    },
                    "& .MuiSvgIcon-root": {
                      color: "black",
                    },
                    "&:hover": {
                      borderColor: "rgba(0, 0, 0, 0.5)",
                      backgroundColor: "rgba(0, 0, 0, 0.04)",
                    },
                  }}
                >
                  <Typography sx={{ display: { xs: "none", md: "inline" } }}>
                    Configure GitHub App
                  </Typography>
                </Button>
              )}
            <IconButton
              onClick={handleRefresh}
              size="small"
              title={`Refresh ${provider === "github" ? "organizations" : "groups"}`}
            >
              <RefreshIcon />
            </IconButton>
            <IconButton onClick={onClose} size="small">
              <CloseIcon />
            </IconButton>
          </div>
        </Box>
        {GITHUB_ENABLED && (
          <Tabs value={provider} onChange={handleProviderChange} aria-label="VCS provider tabs">
            <Tab
              icon={<GitHubIcon />}
              iconPosition="start"
              label="GitHub"
              value="github"
              sx={{ textTransform: "none" }}
            />
            <Tab
              icon={<GitLabIcon />}
              iconPosition="start"
              label="GitLab"
              value="gitlab"
              sx={{ textTransform: "none" }}
            />
          </Tabs>
        )}
      </DialogTitle>
      <DialogContent sx={{ px: { xs: 1.5, sm: 3 } }}>
        {error && (
          <Alert severity="error" sx={{ mb: 2 }}>
            {error}
          </Alert>
        )}
        <TextField
          label="Project key (optional)"
          value={projectKey}
          onChange={(event) => setProjectKey(event.target.value)}
          size="small"
          fullWidth
          sx={{ mb: 2 }}
          helperText={
            "For monorepos with multiple Storybooks: a unique key per project (e.g. web, ui-lib) " +
            "lets one repository host several projects, each reporting its own commit status " +
            "(vizdiff/visual-tests/<key>). Leave empty for a single project per repository."
          }
        />
        <Box
          sx={{
            display: "flex",
            flexDirection: "row",
            alignItems: "stretch",
            gap: { xs: "0.5rem", sm: "1rem" },
            height: "100%",
            minHeight: "300px",
            transition: "opacity 0.2s ease-in-out",
          }}
        >
          {loading || isOrgsLoading || loadingStartTime != null ? (
            <div
              style={{
                display: "flex",
                justifyContent: "center",
                width: "100%",
                opacity: 1,
                transition: "opacity 0.2s ease-in-out",
              }}
            >
              <CircularProgress />
            </div>
          ) : (
            <>
              <div style={{ width: "49%", overflowX: "hidden" }}>
                <h4>{provider === "github" ? "GitHub Organizations" : "GitLab Groups"}</h4>
                {orgs?.length === 0 ? (
                  <Box
                    sx={{
                      display: "flex",
                      flexDirection: "column",
                      alignItems: "center",
                      justifyContent: { xs: "flex-start", sm: "center" },
                      textAlign: { xs: "left", sm: "center" },
                      px: { xs: 0, sm: 3 },
                      py: { xs: 1, sm: 3 },
                      gap: 2,
                    }}
                  >
                    {provider === "github" ? (
                      <>
                        <Typography sx={{ fontSize: { xs: "0.875rem", sm: "1rem" } }}>
                          <strong>GitHub:</strong> Install the vizdiff GitHub App to enable
                          screenshot testing for your GitHub repositories.
                        </Typography>
                        <Button
                          variant="contained"
                          size="large"
                          onClick={handleInstallApp}
                          startIcon={<GitHubIcon />}
                          sx={{
                            mx: { xs: 0.5, sm: 0 },
                            px: { xs: 1, sm: 2 },
                            py: { xs: 0.5, sm: 1 },
                            textAlign: "left",
                            bgcolor: "white",
                            color: "black",
                            "&:hover": {
                              bgcolor: "#f5f5f5",
                            },
                            boxShadow: "0 2px 4px rgba(0,0,0,0.15)",
                          }}
                        >
                          Install GitHub App
                        </Button>
                      </>
                    ) : (
                      <Typography sx={{ fontSize: { xs: "0.875rem", sm: "1rem" } }}>
                        <strong>GitLab:</strong> Select a group to view available projects, or
                        create a project manually to get started with screenshot testing.
                      </Typography>
                    )}
                  </Box>
                ) : (
                  <List
                    component="nav"
                    sx={{
                      overflowY: "auto",
                      maxHeight: "60vh",
                    }}
                  >
                    {orgs?.map((org) => {
                      const orgId = provider === "github" ? (org as GithubOrg).id : org.id
                      const orgLogin = provider === "github" ? (org as GithubOrg).login : org.login
                      const groupId = provider === "gitlab" ? (org as GitLabGroup).id : undefined
                      return (
                        <ListItemButton
                          key={orgId}
                          onClick={() => handleOrgClick(orgLogin, groupId)}
                          sx={{ padding: { xs: 0.5, sm: 1 } }}
                        >
                          <ListItemText primary={orgLogin} />
                        </ListItemButton>
                      )
                    })}
                  </List>
                )}
              </div>
              <Box
                sx={{
                  borderLeft: "1px solid",
                  borderColor: "divider",
                  opacity: 0.3,
                  flexGrow: 1,
                }}
              />
              <Box sx={{ width: "50%", px: { xs: 1, sm: "1rem" } }}>
                <h4>{provider === "github" ? "GitHub Repositories" : "GitLab Projects"}</h4>
                {reposLoading ? (
                  <div
                    style={{
                      display: "flex",
                      justifyContent: "center",
                      alignItems: "center",
                      height: "100%",
                    }}
                  >
                    <CircularProgress />
                  </div>
                ) : (
                  <>
                    {provider === "github" && githubRepos.length > 0 && (
                      <List
                        component="nav"
                        sx={{
                          overflowY: "auto",
                          maxHeight: "60vh",
                        }}
                      >
                        {githubRepos.map((repo) => (
                          <ListItemButton
                            key={repo.id}
                            onClick={() => handleRepoClick(repo)}
                            sx={{ padding: { xs: 0.5, sm: 1 } }}
                          >
                            <ListItemText primary={repo.name} />
                          </ListItemButton>
                        ))}
                      </List>
                    )}
                    {provider === "gitlab" && gitlabProjects.length > 0 && (
                      <List
                        component="nav"
                        sx={{
                          overflowY: "auto",
                          maxHeight: "60vh",
                        }}
                      >
                        {gitlabProjects.map((project) => (
                          <ListItemButton
                            key={project.id}
                            onClick={() => handleRepoClick(project)}
                            sx={{ padding: { xs: 0.5, sm: 1 } }}
                          >
                            <ListItemText primary={project.name} />
                          </ListItemButton>
                        ))}
                      </List>
                    )}
                    {provider === "gitlab" &&
                      gitlabProjects.length === 0 &&
                      githubRepos.length === 0 && (
                        <Typography variant="body2" color="text.secondary" sx={{ px: 2, py: 1 }}>
                          No projects found.
                        </Typography>
                      )}
                  </>
                )}
              </Box>
            </>
          )}
        </Box>
      </DialogContent>
    </Dialog>
  )
}

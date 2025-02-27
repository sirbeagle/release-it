const fs = require('fs');
const path = require('path');
const got = require('got');
const globby = require('globby');
const FormData = require('form-data');
const Release = require('../GitRelease');
const { format, e } = require('../../util');
const prompts = require('./prompts');

const docs = 'https://git.io/release-it-gitlab';

const noop = Promise.resolve();

class GitLab extends Release {
  constructor(...args) {
    super(...args);
    this.registerPrompts(prompts);
    this.assets = [];
  }

  get client() {
    if (this._client) return this._client;
    const { tokenHeader } = this.options;
    const { baseUrl } = this.getContext();
    this._client = got.extend({
      prefixUrl: baseUrl,
      method: 'POST',
      headers: {
        'user-agent': 'webpro/release-it',
        [tokenHeader]: this.token
      }
    });
    return this._client;
  }

  async init() {
    await super.init();
    const { skipChecks, tokenRef, tokenHeader } = this.options;
    const { repo } = this.getContext();
    const hasJobToken = (tokenHeader || '').toLowerCase() === 'job-token';
    const origin = this.options.origin || `https://${repo.host}`;
    this.setContext({
      id: encodeURIComponent(repo.repository),
      origin,
      baseUrl: `${origin}/api/v4`
    });

    if (skipChecks) return;

    if (!this.token) {
      throw e(`Environment variable "${tokenRef}" is required for GitLab releases.`, docs);
    }

    if (!hasJobToken) {
      if (!(await this.isAuthenticated())) {
        throw e(`Could not authenticate with GitLab using environment variable "${tokenRef}".`, docs);
      }
      if (!(await this.isCollaborator())) {
        const { user, repo } = this.getContext();
        throw e(`User ${user.username} is not a collaborator for ${repo.repository}.`, docs);
      }
    }
  }

  async isAuthenticated() {
    if (this.config.isDryRun) return true;
    const endpoint = `user`;
    try {
      const { id, username } = await this.request(endpoint, { method: 'GET' });
      this.setContext({ user: { id, username } });
      return true;
    } catch (err) {
      this.debug(err);
      return false;
    }
  }

  async isCollaborator() {
    if (this.config.isDryRun) return true;
    const { id, user } = this.getContext();
    const endpoint = `projects/${id}/members/all/${user.id}`;
    try {
      const { access_level } = await this.request(endpoint, { method: 'GET' });
      return access_level && access_level >= 30;
    } catch (err) {
      this.debug(err);
      if (err.name === 'HTTPError' && err.response.statusCode === 404) {
        // Using another endpoint, since "/projects/:id/members/all/:user_id" was introduced in v12.4
        const endpoint = `projects/${id}/members/${user.id}`;
        try {
          const { access_level } = await this.request(endpoint, { method: 'GET' });
          return access_level && access_level >= 30;
        } catch (err) {
          this.debug(err);
          return false;
        }
      } else {
        return false;
      }
    }
  }

  async release() {
    const glRelease = () => this.createRelease();
    const glUploadAssets = () => this.uploadAssets();

    if (this.config.isCI) {
      await this.step({ enabled: this.options.assets, task: glUploadAssets, label: 'GitLab upload assets' });
      return await this.step({ task: glRelease, label: 'GitLab release' });
    } else {
      const release = () => glUploadAssets().then(() => glRelease());
      return await this.step({ task: release, label: 'GitLab release', prompt: 'release' });
    }
  }

  async request(endpoint, options) {
    const { baseUrl } = this.getContext();
    this.debug(Object.assign({ url: `${baseUrl}/${endpoint}` }, options));
    const method = (options.method || 'POST').toLowerCase();
    const response = await this.client[method](endpoint, options);
    const body = typeof response.body === 'string' ? JSON.parse(response.body) : response.body || {};
    this.debug(body);
    return body;
  }

  async createRelease() {
    const { releaseName } = this.options;
    const { id, tagName, releaseNotes, repo, origin } = this.getContext();
    const { isDryRun } = this.config;
    const name = format(releaseName, this.config.getContext());
    const description = releaseNotes || '-';
    const releaseUrl = `${origin}/${repo.repository}/-/releases`;

    this.log.exec(`gitlab releases#createRelease "${name}" (${tagName})`, { isDryRun });

    if (isDryRun) {
      this.setContext({ isReleased: true, releaseUrl });
      return true;
    }

    const endpoint = `projects/${id}/releases`;
    const options = {
      json: {
        name,
        tag_name: tagName,
        description
      }
    };

    if (this.assets.length) {
      options.json.assets = {
        links: this.assets
      };
    }

    try {
      await this.request(endpoint, options);
      this.log.verbose('gitlab releases#createRelease: done');
      this.setContext({ isReleased: true, releaseUrl });
      return true;
    } catch (err) {
      this.debug(err);
      throw err;
    }
  }

  async uploadAsset(filePath) {
    const name = path.basename(filePath);
    const { id, origin, repo } = this.getContext();
    const endpoint = `projects/${id}/uploads`;

    const body = new FormData();
    body.append('file', fs.createReadStream(filePath));
    const options = { body };

    try {
      const body = await this.request(endpoint, options);
      this.log.verbose(`gitlab releases#uploadAsset: done (${body.url})`);
      this.assets.push({
        name,
        url: `${origin}/${repo.repository}${body.url}`
      });
    } catch (err) {
      this.debug(err);
      throw err;
    }
  }

  uploadAssets() {
    const { assets } = this.options;
    const { isDryRun } = this.config;

    this.log.exec('gitlab releases#uploadAssets', assets, { isDryRun });

    if (!assets || isDryRun) {
      return noop;
    }

    return globby(assets).then(files => {
      if (!files.length) {
        this.log.warn(`gitlab releases#uploadAssets: could not find "${assets}" relative to ${process.cwd()}`);
      }
      return Promise.all(files.map(filePath => this.uploadAsset(filePath)));
    });
  }
}

module.exports = GitLab;

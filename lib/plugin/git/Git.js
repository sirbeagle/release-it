const { EOL } = require('os');
const _ = require('lodash');
const findUp = require('find-up');
const { format, e } = require('../../util');
const GitBase = require('../GitBase');
const prompts = require('./prompts');

const noop = Promise.resolve();
const invalidPushRepoRe = /^\S+@/;
const options = { write: false };
const fixArgs = args => (args ? (typeof args === 'string' ? args.split(' ') : args) : []);

const docs = 'https://git.io/release-it-git';

class Git extends GitBase {
  constructor(...args) {
    super(...args);
    this.registerPrompts(prompts);
  }

  static async isEnabled(options) {
    return options !== false && (await findUp('.git', { type: 'directory' }));
  }

  async init() {
    if (this.options.requireBranch && !(await this.isRequiredBranch(this.options.requireBranch))) {
      throw e(`Must be on branch ${this.options.requireBranch}`, docs);
    }
    if (this.options.requireCleanWorkingDir && !(await this.isWorkingDirClean())) {
      throw e(`Working dir must be clean.${EOL}Please stage and commit your changes.`, docs);
    }
    await super.init();
    if (this.options.push && !this.remoteUrl) {
      throw e(`Could not get remote Git url.${EOL}Please add a remote repository.`, docs);
    }
    if (this.options.requireUpstream && !(await this.hasUpstreamBranch())) {
      throw e(`No upstream configured for current branch.${EOL}Please set an upstream branch.`, docs);
    }
    if (this.options.requireCommits && (await this.getCommitsSinceLatestTag()) === 0) {
      throw e(`There are no commits since the latest tag.`, docs);
    }
    this.config.setContext({ repo: this.getContext('repo') });
  }

  rollback() {
    this.log.info('Rolling back changes...');
    const { isCommitted, isTagged, tagName } = this.getContext();
    if (isTagged) {
      this.exec(`git tag --delete ${tagName}`);
    }
    this.exec(`git reset --hard HEAD${isCommitted ? '~1' : ''}`);
  }

  enableRollback() {
    this.rollbackOnce = _.once(this.rollback.bind(this));
    process.on('SIGINT', this.rollbackOnce);
    process.on('exit', this.rollbackOnce);
  }

  disableRollback() {
    if (this.rollbackOnce) {
      process.removeListener('SIGINT', this.rollbackOnce);
      process.removeListener('exit', this.rollbackOnce);
    }
  }

  async beforeRelease() {
    if (this.options.commit) {
      if (this.options.requireCleanWorkingDir) {
        this.enableRollback();
      }
      const changeSet = await this.status();
      this.log.preview({ title: 'changeset', text: changeSet });
      await this.stageDir();
    }
  }

  async release() {
    const { commit, tag, push } = this.options;
    await this.step({ enabled: commit, task: () => this.commit(), label: 'Git commit', prompt: 'commit' });
    await this.step({ enabled: tag, task: () => this.tag(), label: 'Git tag', prompt: 'tag' });
    return !!(await this.step({ enabled: push, task: () => this.push(), label: 'Git push', prompt: 'push' }));
  }

  async isRequiredBranch() {
    const branch = await this.getBranchName();
    const requiredBranches = _.castArray(this.options.requireBranch);
    return requiredBranches.includes(branch);
  }

  async hasUpstreamBranch() {
    const ref = await this.exec('git symbolic-ref HEAD', { options });
    const branch = await this.exec(`git for-each-ref --format="%(upstream:short)" ${ref}`, { options }).catch(
      () => null
    );
    return Boolean(branch);
  }

  tagExists(tag) {
    return this.exec(`git show-ref --tags --quiet --verify -- refs/tags/${tag}`, { options }).then(
      () => true,
      () => false
    );
  }

  isWorkingDirClean() {
    return this.exec('git diff --quiet HEAD', { options }).then(
      () => true,
      () => false
    );
  }

  async getCommitsSinceLatestTag() {
    const latestTagName = await this.getLatestTagName();
    const ref = latestTagName ? `${latestTagName}..HEAD` : 'HEAD';
    return this.exec(`git rev-list ${ref} --count`, { options }).then(Number);
  }

  async getUpstreamArgs(pushRepo) {
    if (pushRepo && !this.isRemoteName(pushRepo)) {
      // Use (only) `pushRepo` if it's configured and looks like a url
      return [pushRepo];
    } else if (!(await this.hasUpstreamBranch())) {
      // Start tracking upstream branch (`pushRepo` is a name if set)
      return ['--set-upstream', pushRepo || 'origin', await this.getBranchName()];
    } else if (pushRepo && !invalidPushRepoRe.test(pushRepo)) {
      return [pushRepo];
    } else {
      return [];
    }
  }

  stage(file) {
    if (!file || !file.length) return noop;
    const files = _.castArray(file);
    return this.exec(['git', 'add', ...files]).catch(err => {
      this.log.warn(`Could not stage ${files}`);
      this.debug(err);
    });
  }

  stageDir({ baseDir = '.' } = {}) {
    const { addUntrackedFiles } = this.options;
    return this.exec(['git', 'add', baseDir, addUntrackedFiles ? '--all' : '--update']);
  }

  reset(file) {
    const files = _.castArray(file);
    return this.exec(['git', 'checkout', 'HEAD', '--', ...files]).catch(err => {
      this.log.warn(`Could not reset ${files}`);
      this.debug(err);
    });
  }

  status() {
    return this.exec('git status --short --untracked-files=no', { options }).catch(() => null);
  }

  commit({ message = this.options.commitMessage, args = this.options.commitArgs } = {}) {
    const msg = format(message, this.config.getContext());
    return this.exec(['git', 'commit', '--message', msg, ...fixArgs(args)]).then(
      () => this.setContext({ isCommitted: true }),
      err => {
        this.debug(err);
        if (/nothing (added )?to commit/.test(err) || /nichts zu committen/.test(err)) {
          this.log.warn('No changes to commit. The latest commit will be tagged.');
        } else {
          throw new Error(err);
        }
      }
    );
  }

  tag({ name, annotation = this.options.tagAnnotation, args = this.options.tagArgs } = {}) {
    const message = format(annotation, this.config.getContext());
    const tagName = name || this.getContext('tagName');
    return this.exec(['git', 'tag', '--annotate', '--message', message, ...fixArgs(args), tagName])
      .then(() => this.setContext({ isTagged: true }))
      .catch(err => {
        const { latestTagName, tagName } = this.getContext();
        if (/tag '.+' already exists/.test(err) && latestTagName === tagName) {
          this.log.warn(`Tag "${tagName}" already exists`);
        } else {
          throw err;
        }
      });
  }

  async push({ args = this.options.pushArgs } = {}) {
    const { pushRepo } = this.options;
    const upstreamArgs = await this.getUpstreamArgs(pushRepo);
    const push = await this.exec(['git', 'push', ...fixArgs(args), ...upstreamArgs]);
    this.disableRollback();
    return push;
  }

  afterRelease() {
    this.disableRollback();
  }
}

module.exports = Git;

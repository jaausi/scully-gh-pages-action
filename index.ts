import * as core from '@actions/core';
import * as exec from '@actions/exec';
import * as github from '@actions/github';
import * as io from '@actions/io';
import * as ioUtil from '@actions/io/lib/io-util';
import * as lockfile from '@yarnpkg/lockfile';
import semver from 'semver';
import { readFileSync } from 'fs';

const DEFAULT_DEPLOY_BRANCH = 'main';

async function run(): Promise<void> {
  try {
    const accessToken = core.getInput('access-token');
    if (!accessToken) {
      core.setFailed(
        'No personal access token found. Please provide one by setting the `access-token` input for this action.',
      );
      return;
    }

    let deployBranch = core.getInput('deploy-branch');
    if (!deployBranch) deployBranch = DEFAULT_DEPLOY_BRANCH;

    if (github.context.ref === `refs/heads/${deployBranch}`) {
      console.log(`Triggered by branch used to deploy: ${github.context.ref}.`);
      console.log('Nothing to deploy.');
      return;
    }

    const pkgManager = (await ioUtil.exists('./yarn.lock')) ? 'yarn' : 'npm';
    const installCmd = pkgManager === 'yarn' ? 'install --frozen-lockfile' : 'ci';
    console.log(`Installing your site's dependencies using ${pkgManager}.`);
    await exec.exec(`${pkgManager} ${installCmd}`);
    console.log('Finished installing dependencies.');

    let buildArgs = core.getInput('build-args').trim();
    // Add dashes if a user passes args and doesnt have them.
    if (buildArgs !== '' && buildArgs.indexOf('-- ') !== 0) {
      buildArgs = `-- ${buildArgs}`;
    }

    let scullyArgs = core.getInput('scully-args').trim();
    // Remove dashes if the scullyArgs have them
    //  This is because we now pass --nw by default.
    if (scullyArgs.indexOf('-- ') === 0) {
      scullyArgs = scullyArgs.slice(3);
    }

    console.log('Ready to build your Scully site!');
    console.log(`Building with: ${pkgManager} run build ${buildArgs}`);
    await exec.exec(`${pkgManager} run build ${buildArgs}`, []);
    console.log('Finished building your site.');

    // determine the scully version
    let scullyVersion;
    if (pkgManager === 'yarn') {
      console.log("Determine Scully version from './yarn.lock'.");
      const yarnLockRaw = readFileSync('./yarn.lock', 'utf8');
      const yarnLockParsed = lockfile.parse(yarnLockRaw);
      // result contains a list with e.g. "@scullyio/scully@^0.0.85" as key, so we have to find teh matching object key
      const getScullyChildObjectKey = Object.keys(yarnLockParsed.object).filter((p: string) =>
        /@scullyio\/scully/.test(p),
      );
      // use the found key to get the version from the object
      scullyVersion = yarnLockParsed.object[getScullyChildObjectKey[0]].version;
    } else {
      console.log("Determine Scully version from './package-lock.json'.");
      const packageLockJsonRaw = readFileSync('./package-lock.json', 'utf8');
      const packageLockJsonParsed = JSON.parse(packageLockJsonRaw);
      scullyVersion = packageLockJsonParsed.dependencies['@scullyio/scully'].version;
    }
    console.log(`Scully Version ${scullyVersion} is used`);

    // add the `--nw` flag if scully version is below or equal `0.0.85`
    if (semver.lte(scullyVersion, '0.0.85')) {
      console.log(`Scully Version is less then '0.0.85', adding '--nw' flag`);
      scullyArgs = `--nw ${scullyArgs}`;
    }

    await exec.exec(`${pkgManager} run scully -- ${scullyArgs}`, []);
    console.log('Finished Scullying your site.');

    const cnameExists = await ioUtil.exists('./CNAME');
    if (cnameExists) {
      console.log('Copying CNAME over.');
      await io.cp('./CNAME', './dist/static/CNAME', { force: true });
      console.log('Finished copying CNAME.');
    }

    const repo = `${github.context.repo.owner}/${github.context.repo.repo}`;
    const repoURL = `https://${accessToken}@github.com/${repo}.git`;
    console.log('Ready to deploy your new shiny site!');
    console.log(`Deploying to repo: ${repo} and branch: ${deployBranch}`);
    console.log('You can configure the deploy branch by setting the `deploy-branch` input for this action.');
    await exec.exec(`git init`, [], { cwd: './dist/static' });
    await exec.exec(`git config user.name`, [github.context.actor], {
      cwd: './dist/static',
    });
    await exec.exec(`git config user.email`, [`${github.context.actor}@users.noreply.github.com`], {
      cwd: './dist/static',
    });
    await exec.exec(`git add`, ['.'], { cwd: './dist/static' });
    await exec.exec(`git commit`, ['-m', `deployed via Scully Publish Action 🎩 for ${github.context.sha}`], {
      cwd: './dist/static',
    });
    await exec.exec(`git push`, ['-f', repoURL, `main:${deployBranch}`], {
      cwd: './dist/static',
    });
    console.log('Finished deploying your site.');

    console.log('Enjoy! ✨');
    core.setOutput('success', true);
  } catch (error) {
    if (error instanceof Error) core.setFailed(error.message);
  }
}

// Don't auto-execute in the test environment
if (process.env['NODE_ENV'] !== 'test') {
  run();
}

export default run;

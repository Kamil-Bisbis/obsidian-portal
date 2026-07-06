import { readFileSync, writeFileSync } from 'fs';

const targetVersion = process.env.npm_package_version;

if (!targetVersion) {
	throw new Error('npm_package_version is missing');
}

// keep manifest version matched to package.json
const manifest = JSON.parse(readFileSync('manifest.json', 'utf8'));
const { minAppVersion } = manifest;

manifest.version = targetVersion;
writeFileSync('manifest.json', JSON.stringify(manifest, null, '\t') + '\n');

// add the version mapping if it is not already there
const versions = JSON.parse(readFileSync('versions.json', 'utf8'));

if (!(targetVersion in versions)) {
	versions[targetVersion] = minAppVersion;
	writeFileSync('versions.json', JSON.stringify(versions, null, '\t') + '\n');
}
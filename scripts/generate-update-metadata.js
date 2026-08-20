const { createHash } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const directory = path.resolve(process.argv[2] || ".");
const version = process.argv[3];
if (!version) throw new Error("Usage: generate-update-metadata.js <artifact-dir> <version>");

const files = fs.readdirSync(directory).filter((name) => /\.(exe|zip|AppImage)$/.test(name));
const groups = [
  ["latest.yml", files.filter((name) => name.endsWith(".exe"))],
  ["latest-mac.yml", files.filter((name) => name.endsWith(".zip"))],
  ["latest-linux.yml", files.filter((name) => name.endsWith(".AppImage"))],
];

for (const [manifest, artifacts] of groups) {
  if (!artifacts.length) continue;
  const details = artifacts.map((name) => {
    const contents = fs.readFileSync(path.join(directory, name));
    return {
      name: name.replace(/ /g, "-"),
      size: contents.length,
      sha512: createHash("sha512").update(contents).digest("base64"),
    };
  });
  const primary = details[0];
  const yaml = [
    `version: ${version}`,
    "files:",
    ...details.flatMap((file) => [
      `  - url: ${file.name}`,
      `    sha512: ${file.sha512}`,
      `    size: ${file.size}`,
    ]),
    `path: ${primary.name}`,
    `sha512: ${primary.sha512}`,
    `releaseDate: '${new Date().toISOString()}'`,
    "",
  ].join("\n");
  fs.writeFileSync(path.join(directory, manifest), yaml);
}

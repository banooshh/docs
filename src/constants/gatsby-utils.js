const fs = require("fs");
const asyncFs = require("fs/promises");
const path = require("path");

const sortVersionArray = (versions) => {
  return versions.sort((a, b) =>
    b.localeCompare(a, undefined, { numeric: true }),
  );
};

const replacePathVersion = (path, version = "latest") => {
  const splitPath = path.split("/");
  const postVersionPath = splitPath.slice(3).join("/");
  return `/${splitPath[1]}/${version}${
    postVersionPath.length > 0 ? `/${postVersionPath}` : "/"
  }`;
};

const filePathToDocType = (filePath) => {
  if (filePath.includes("/product_docs/")) {
    return "doc";
  } else if (filePath.includes("/advocacy_docs/")) {
    return "advocacy";
  }
};

const removeTrailingSlash = (url) => {
  if (url.endsWith("/")) {
    return url.slice(0, -1);
  }
  return url;
};

const isPathAnIndexPage = (filePath) =>
  filePath.endsWith("/index.mdx") || filePath === "index.mdx";

const removeNullEntries = (obj) => {
  if (!obj) return obj;
  for (const [key, value] of Object.entries(obj)) {
    if (value == null) delete obj[key];
  }
  return obj;
};

const pathToDepth = (path) => {
  return path.split("/").filter((s) => s.length > 0).length;
};

const mdxNodesToTree = (nodes) => {
  const buildNode = (path, parent) => {
    return {
      path: path,
      parent: parent,
      children: [],
      mdxNode: null,
      depth: pathToDepth(path),
    };
  };

  const rootNode = buildNode("/", null);

  const findOrInsertNode = (currentNode, path) => {
    const node = currentNode.children.find((child) => child.path === path);
    if (node) return node;

    const newNode = buildNode(path, currentNode);
    currentNode.children.push(newNode);
    return newNode;
  };

  const addNode = (node) => {
    const splitPath = node.fields.path.split("/");
    let currentNode = rootNode;
    for (let i = 2; i < splitPath.length; i++) {
      const path = `/${splitPath.slice(1, i).join("/")}/`;
      currentNode = findOrInsertNode(currentNode, path);
      if (path === node.fields.path) {
        currentNode.mdxNode = node;
      }
    }
  };

  nodes.forEach((node) => addNode(node));

  return rootNode;
};

const computeFrontmatterForTreeNode = (treeNode) => {
  let frontmatter = {
    ...removeNullEntries(treeNode.mdxNode.frontmatter.directoryDefaults),
    ...removeNullEntries(treeNode.mdxNode.frontmatter),
  };

  let current;
  let parent = treeNode.parent;
  while (parent) {
    current = parent;
    parent = current.parent;
    if (!current.mdxNode) continue;
    frontmatter = {
      ...removeNullEntries(current.mdxNode.frontmatter.directoryDefaults),
      ...frontmatter,
    };
  }

  return frontmatter;
};

const buildProductVersions = (nodes) => {
  const versionIndex = {};

  nodes.forEach((node) => {
    const { docType, product, version } = node.fields;
    if (docType !== "doc") return;

    if (!versionIndex[product]) {
      versionIndex[product] = [version];
    } else {
      if (!versionIndex[product].includes(version)) {
        versionIndex[product].push(version);
      }
    }
  });

  for (const product in versionIndex) {
    versionIndex[product] = sortVersionArray(versionIndex[product]);
  }

  return versionIndex;
};

const reportMissingIndex = (reporter, treeNode) => {
  // the starting node won't have a mdxNode, so we need to find one to determine docType
  let curr = treeNode;
  while (curr && !curr.mdxNode) curr = curr.children[0];
  if (!curr) return;

  if (treeNode.depth >= 2) {
    reporter.warn(`${treeNode.path} is missing index.mdx`);
  }
};

const treeNodeToNavNode = (treeNode, withItems = false) => {
  const frontmatter = treeNode.mdxNode?.frontmatter;
  const interactive =
    frontmatter?.showInteractiveBadge != null
      ? frontmatter?.showInteractiveBadge
      : !!frontmatter?.katacodaPanel;

  const navNode = {
    path: treeNode.path,
    navTitle: frontmatter?.navTitle,
    title: frontmatter?.title,
    hideVersion: frontmatter?.hideVersion,
    displayBanner: frontmatter?.displayBanner,
    depth: treeNode.mdxNode?.fields?.depth,
    iconName: frontmatter?.iconName,
    description: frontmatter?.description,
    interactive: interactive,
    childCount: treeNode.children.length,
  };
  if (withItems) navNode.items = [];
  return navNode;
};

const treeToNavigation = (treeNode, pageNode) => {
  const rootNode = treeNodeToNavNode(treeNode, true);
  const { depth, path } = pageNode.fields;

  let curr = treeNode;
  let items = rootNode.items;
  while (curr && curr.depth <= depth) {
    let next = [];
    let nextItems = [];

    if (!curr.navigationNodes) break;

    curr.navigationNodes.forEach((navNode) => {
      const newNavNode = { ...navNode, items: [] };
      items.push(newNavNode);
      if (path.includes(newNavNode.path)) {
        next.push(
          curr.children.find((child) => child.path === newNavNode.path),
        );
        nextItems.push(newNavNode.items);
      }
    });

    curr = next.pop();
    items = nextItems.pop();
  }

  return rootNode;
};

const getNavNodeForTreeNode = (treeNode) => {
  if (!treeNode.parent?.navigationNodes) return null;

  return treeNode.parent.navigationNodes.find((navNode) => {
    return navNode.path === treeNode.path;
  });
};

const getTreeNodeForNavNode = (parent, navNode) => {
  return parent.children.find((child) => child.path === navNode.path);
};

const flattenTree = (flatArray, nodes) => {
  nodes.forEach((node) => {
    const { items, ...newNode } = node;
    flatArray.push(newNode);
    flattenTree(flatArray, items || []);
  });
};

const findPrevNextNavNodes = (navTree, currNode) => {
  const prevNext = { prev: null, next: null };

  const parent = currNode.parent; // parent nav nodes should contain currNode
  if (!parent.navigationNodes) return prevNext;

  const currNavNodeIndex = parent.navigationNodes.findIndex((navNode) => {
    return navNode.path === currNode.path;
  });

  // hunt for prev node
  if (currNavNodeIndex > 0) {
    let prevNavNode = parent.navigationNodes[currNavNodeIndex - 1];

    while (prevNavNode) {
      const prevTreeNode = getTreeNodeForNavNode(parent, prevNavNode);
      if (!prevTreeNode) break;
      const lastNavNode = prevTreeNode.navigationNodes?.slice(-1)?.[0];
      if (!lastNavNode) break;
      prevNavNode = lastNavNode;
    }

    prevNext.prev = prevNavNode;
  } else {
    prevNext.prev = getNavNodeForTreeNode(parent);
  }

  // hunt for next node
  const flatTree = [];
  flattenTree(flatTree, navTree.items);
  const index = flatTree.findIndex((navItem) => navItem.path === currNode.path);
  if (index < flatTree.length - 1) {
    prevNext.next = flatTree[index + 1];
  }

  if (!prevNext.prev?.path) prevNext.prev = null;
  if (!prevNext.next?.path) prevNext.next = null;

  return prevNext;
};

const preprocessPathsAndRedirects = (nodes, productVersions) => {
  const validPaths = new Set();
  for (let node of nodes) {
    const nodePath = node.fields?.path;
    if (!nodePath) continue;
    const splitPath = nodePath.split(path.sep);
    const isLatest =
      node.fields.docType === "doc" &&
      productVersions[node.fields.product][0] === node.fields.version;
    const nodePathLatest = isLatest && replacePathVersion(nodePath);

    validPaths.add(nodePath);
    if (isLatest) validPaths.add(nodePathLatest);

    const redirects = node.frontmatter?.redirects;
    if (!redirects || !redirects.length) continue;

    const newRedirects = new Set();
    const addNewRedirect = (redirect) => {
      if (validPaths.has(redirect))
        console.warn(`Redirect ${redirect} for page ${nodePath} matches the path of a page or redirect already added and will be ignored!
::warning file=${node.fileAbsolutePath},title=Overlapping redirect::Redirect matches another redirect or page path, ${redirect}`);
      newRedirects.add(redirect);
    };
    for (let redirect of redirects) {
      if (!redirect) continue;

      // allow relative paths in redirects
      let fromPath = path.resolve(path.sep, nodePath, redirect) + path.sep;

      // Special handling for redirects Part A
      // -------------------------------------
      // It has become something of a habit to use "latest" paths in redirects
      // (possibly because - for good reason - it is the easiest path to copy)
      // However, this becomes an issue when these creep into older versions...
      // Therefore, we will treat them specially:
      // *In redirects*, if...
      // ...the first part of the path is equal for [from] and [to], and...
      // ...the second part of the [from] path is "latest"
      // ...Then the second part of the [from] path will be replaced with the
      // second part of the [to] path.
      const splitFromPath = fromPath.split(path.sep);
      const fromIsLatest = splitFromPath[2] === "latest";
      if (fromIsLatest && splitFromPath[1] === splitPath[1])
        fromPath = path.join(
          path.sep,
          splitFromPath[1],
          splitPath[2],
          ...splitFromPath.slice(3),
          path.sep,
        );

      if (fromPath !== nodePath) addNewRedirect(fromPath);
    }

    for (let redirect of newRedirects) validPaths.add(redirect);

    node.frontmatter.redirects = [...newRedirects];
  }
  return validPaths;
};

const configureRedirects = (
  toPath,
  redirects,
  actions,
  isLatest,
  pathVersions,
) => {
  const lastVersionPath = pathVersions.find((p) => !!p);
  const isLastVersion = toPath === lastVersionPath;
  // latest version should always redirect to .../latest/...
  if (isLatest) {
    actions.createRedirect({
      fromPath: toPath,
      toPath: replacePathVersion(toPath),
      redirectInBrowser: true,
      isPermanent: false,
      force: true,
    });
    toPath = replacePathVersion(toPath);
  }
  // if this path is a dead-end (it does not exist in any newer versions
  // of the product, and also does not have a matching redirect in any newer versions)
  // then prevent a 404 for previously-valid latest paths by redirecting them to
  // this version of the file
  else if (isLastVersion) {
    actions.createRedirect({
      fromPath: replacePathVersion(toPath),
      toPath,
      redirectInBrowser: true,
      isPermanent: false,
    });
  }

  if (!redirects) return;

  const splitToPath = toPath.split(path.sep);
  for (let fromPath of redirects) {
    if (!fromPath) continue;
    if (fromPath !== toPath) {
      const splitFromPath = fromPath.split(path.sep);
      const isPermanent =
        splitFromPath[2] !== "latest" && splitToPath[2] !== "latest";
      actions.createRedirect({
        fromPath,
        toPath,
        redirectInBrowser: true,
        isPermanent,
      });
    }

    // Special handling for redirects Part B
    // -------------------------------------
    // When creating redirects due to reorganization (moving/renaming a file) in the latest version of a product,
    // it is generally beneficial to have two redirects: one with the versioned path (e.g. /pem/9/...) and one
    // with the "latest" path (e.g. /pem/latest/...)
    // To avoid the need to write and maintain two redirects for every file move, we will automatically create
    // the latter *when a redirect is found for the latest version of a given file*.
    //
    // Note: the latest version of a given file is *not* necessarily the latest version of the product that
    // file belongs to. For example, the latest version of PEM 8 release notes exists in the PEM 8 docs, not the PEM 9 docs.
    // HOWEVER, this means that there is an opportunity for confusion when a file is renamed multiple times across multiple
    // versions, with each revision keeping the same redirect. Hence the need to handle Part B here: we can now treat
    // the existence of a matching redirect in a newer version as equivalent to a newer version of the page, and avoid
    // generating a "latest" redirect for it. IOW, all that is needed is to *add* a new redirect every time a page is
    // renamed; failing to prune old redirects when forking a new version will not cause issues.
    //
    // Note: this works with Part A (described above in preprocessPathsAndRedirects()) to allow maintainers to create redirects in *only*
    // the 2nd form and trust that they will then result in the correct behavior for both older versions
    // (wherein a single redirect for that product version only will be created) AND for the latest version
    // (wherein two redirects, one for that product version and one for "[product]/latest/path" will be created).
    //
    // Example:
    //   /epas/14/B
    //     redirects: [/epas/latest/A]
    //   /epas/15/C
    //     redirects: [/epas/latest/A,/epas/latest/B]
    //
    //  ...results in:
    //    /epas/14/A -> /epas/14/B
    //    /epas/15/A -> /epas/15/C
    //    /epas/15/B -> /epas/15/C
    //    /epas/latest/A -> /epas/latest/C
    //    /epas/latest/B -> /epas/latest/C
    const toIsLatest = isLatest || isLastVersion;
    if (toIsLatest) {
      fromPath = replacePathVersion(fromPath);
      if (fromPath !== toPath)
        actions.createRedirect({
          fromPath,
          toPath,
          redirectInBrowser: true,
          isPermanent: false,
        });
    }
  }
};

const convertLegacyDocsPathToLatest = (fromPath) => {
  return fromPath
    .replace(/\/\d+(\.?\d+)*\//, "/latest/") // version in middle of path
    .replace(/\/\d+(\.?\d+)*$/, "/latest"); // version at end of path (product index)
};

const configureLegacyRedirects = ({
  toPath,
  toLatestPath,
  redirects,
  actions,
}) => {
  if (!redirects) return;

  redirects.forEach((fromPath) => {
    /*
      Three kinds of redirects
      - redirects from versioned path to new versioned path, not latest version
      - redirects from versioned path to new versioned path, latest version
        - latest versioned path will redirect to /latest, meaning you would have two redirects
      - redirects from latest path to new latest path
    */

    actions.createRedirect({
      fromPath,
      toPath: toPath,
      isPermanent: true,
    });

    if (toLatestPath) {
      actions.createRedirect({
        fromPath: convertLegacyDocsPathToLatest(fromPath),
        toPath: toLatestPath,
        isPermanent: true,
      });
    }
  });
};

/**
 * @description Used to create a publicly-accessible file from a File node. Suitable for sample files, PDFs, etc.
 * @param {File} node the File node to create a PublicFile node based on
 * @param {Function} createNodeId Gatsby API helper
 * @param {Actions} actions Gatsby API actions
 * @param {String} basePath Defaults to "" - used to specify a URL path prefix for the public file
 * @param {String} mimeType optional - used to override Netlify's content-type for a given file
 * @returns {Boolean} true if successful
 */
const makeFileNodePublic = async (
  node,
  createNodeId,
  actions,
  { basePath = "", mimeType } = {},
) => {
  const { createNode, createParentChildLink } = actions;
  const product =
    (node.sourceInstanceName !== "advocacy_docs" && node.sourceInstanceName) ||
    undefined;
  const version =
    (product && node.relativePath.split(path.sep)[0]) || undefined;
  const relativePath = !product
    ? node.relativePath
    : path.join(product, node.relativePath);

  const publicPath = path.join(process.cwd(), `public`, basePath, relativePath);

  let copied = false;
  try {
    await asyncFs.mkdir(path.dirname(publicPath), { recursive: true });
    await asyncFs.copyFile(node.absolutePath, publicPath);
    copied = true;
  } catch (err) {
    console.error(
      `error copying file from ${node.absolutePath} to ${publicPath}`,
      err,
    );
  }

  if (copied) {
    const publicFileNodeDef = {
      urlPath: path.join("/", basePath, relativePath),
      absolutePath: publicPath,
      mimeType,
      product,
      version,
      ext: node.ext,
      extension: node.extension,
      id: createNodeId("public" + node.id),
      parent: node.id,
      children: [],
      internal: {
        type: "PublicFile",
        contentDigest: node.internal.contentDigest,
      },
    };
    await createNode(publicFileNodeDef);

    createParentChildLink({ parent: node, child: publicFileNodeDef });
  }

  return copied;
};

const readFile = (filePath) =>
  new Promise(function (resolve, reject) {
    fs.readFile(filePath, "utf8", function (err, data) {
      err ? reject(err) : resolve(data);
    });
  });

const writeFile = (filePath, data) =>
  new Promise(function (resolve, reject) {
    fs.writeFile(filePath, data, function (err) {
      err ? reject(err) : resolve();
    });
  });

module.exports = {
  replacePathVersion,
  filePathToDocType,
  removeTrailingSlash,
  isPathAnIndexPage,
  removeNullEntries,
  pathToDepth,
  mdxNodesToTree,
  computeFrontmatterForTreeNode,
  buildProductVersions,
  reportMissingIndex,
  treeToNavigation,
  treeNodeToNavNode,
  findPrevNextNavNodes,
  preprocessPathsAndRedirects,
  configureRedirects,
  configureLegacyRedirects,
  makeFileNodePublic,
  readFile,
  writeFile,
};

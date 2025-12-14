export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const pathname = url.pathname;

    const domain = env.DOMAIN;
    const DATABASE = env.DATABASE;
    const USERNAME = env.USERNAME;
    const PASSWORD = env.PASSWORD;
    const adminPath = env.ADMIN_PATH || "admin";
    const enableAuth = env.ENABLE_AUTH === "true";
    const TG_BOT_TOKEN = env.TG_BOT_TOKEN;
    const TG_CHAT_ID = env.TG_CHAT_ID;

    // 1) API路由优先
    if (pathname === "/upload") {
      return request.method === "POST"
        ? await handleUploadRequest(
            request,
            DATABASE,
            enableAuth,
            USERNAME,
            PASSWORD,
            domain,
            TG_BOT_TOKEN,
            TG_CHAT_ID
          )
        : new Response("Method Not Allowed", { status: 405 });
    }

    if (pathname === "/bing-images") {
      return await handleBingImagesRequest();
    }

    if (pathname === "/delete-images") {
      return await handleDeleteImagesRequest(request, DATABASE, USERNAME, PASSWORD);
    }

    if (pathname === "/move-images") {
      return request.method === "POST"
        ? await handleMoveImagesRequest(request, DATABASE, USERNAME, PASSWORD)
        : new Response("Method Not Allowed", { status: 405 });
    }

    if (pathname === "/folders") {
      return await handleFoldersRequest(request, DATABASE, USERNAME, PASSWORD);
    }

    // 2) 管理后台（动态页面）
    if (pathname === `/${adminPath}`) {
      if (!authenticate(request, USERNAME, PASSWORD)) {
        return new Response("Unauthorized", {
          status: 401,
          headers: { "WWW-Authenticate": 'Basic realm="Admin"' },
        });
      }
      return await generateAdminPageLite(DATABASE, USERNAME, PASSWORD);
    }

    // 3) 首页（静态 + 可选鉴权）
    if (pathname === "/") {
      if (enableAuth && !authenticate(request, USERNAME, PASSWORD)) {
        return new Response("Unauthorized", {
          status: 401,
          headers: { "WWW-Authenticate": 'Basic realm="Admin"' },
        });
      }
      return env.ASSETS.fetch(request);
    }

    // 4) 其他静态资源交给Pages
    const assetResp = await env.ASSETS.fetch(request);
    if (assetResp.status !== 404) return assetResp;

    // 5) 静态不存在 -> 当作图片/视频资源，从数据库查Telegram fileId转发
    return await handleImageRequest(request, DATABASE, TG_BOT_TOKEN);
  },
};

// ===== 工具函数（鉴权）=====
function authenticate(request, USERNAME, PASSWORD) {
  const authHeader = request.headers.get("Authorization");
  if (!authHeader) return false;
  return isValidCredentials(authHeader, USERNAME, PASSWORD);
}

function isValidCredentials(authHeader, USERNAME, PASSWORD) {
  const base64Credentials = authHeader.split(" ")[1];
  if (!base64Credentials) return false;
  const credentials = atob(base64Credentials).split(":");
  return credentials[0] === USERNAME && credentials[1] === PASSWORD;
}

// ===== 计算文件总大小函数（关键修复）=====
function formatTotalSize(mediaData) {
  const totalBytes = mediaData.reduce((sum, media) => sum + (media.fileSize || 0), 0);
  if (totalBytes === 0) return "0 Bytes";
  const k = 1024;
  const sizes = ["Bytes", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(totalBytes) / Math.log(k));
  return (totalBytes / Math.pow(k, i)).toFixed(1) + " " + sizes[i];
}

// ===== 管理后台：轻量版HTML（外部admin.css/admin.js）=====
async function generateAdminPageLite(DATABASE, USERNAME, PASSWORD) {
  try {
    const foldersResult = await DATABASE.prepare("SELECT * FROM folders ORDER BY name").all();
    const folders = foldersResult.results || [];

    const mediaResult = await DATABASE.prepare(
      "SELECT url, fileId, folder_id, uploaded_at, file_size FROM media ORDER BY uploaded_at DESC"
    ).all();
    const mediaData = mediaResult.results || [];

    const enhancedMediaData = mediaData.map((row) => {
      const url = row.url;
      const fileExtension = url.split(".").pop().toLowerCase();
      const timestamp = url.split("/").pop().split(".")[0];
      const uploadedTime = row.uploaded_at
        ? new Date(row.uploaded_at)
        : new Date(parseInt(timestamp));
      const fileSize = row.file_size || 0;

      return {
        ...row,
        fileExtension,
        timestamp: parseInt(timestamp),
        uploadedTime,
        fileSize,
        fileName: url.split("/").pop(),
        folderName: folders.find((f) => f.id === row.folder_id)?.name || "未分类",
      };
    });

    const totalFiles = enhancedMediaData.length;
    const totalSize = formatTotalSize(enhancedMediaData);

    const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>图库管理后台</title>
  <link rel="icon" href="https://p1.meituan.net/csc/c195ee91001e783f39f41ffffbbcbd484286.ico" type="image/x-icon">
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
  <link rel="stylesheet" href="/static/admin.css">
  <script>
    window.__DATA__ = ${JSON.stringify({
      folders,
      allMedia: enhancedMediaData,
      USERNAME,
      PASSWORD,
      totalFiles,
      totalSize,
    })};
  </script>
</head>
<body>
  <div id="admin-app"></div>
  <script src="/static/admin.js"></script>
</body>
</html>`;

    return new Response(html, {
      status: 200,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-cache",
      },
    });
  } catch (error) {
    console.error("生成管理页面失败:", error);
    return new Response("内部服务器错误", { status: 500 });
  }
}

// ===== 上传处理（已修复formData catch崩溃）=====
async function handleUploadRequest(
  request,
  DATABASE,
  enableAuth,
  USERNAME,
  PASSWORD,
  domain,
  TG_BOT_TOKEN,
  TG_CHAT_ID
) {
  let formData;
  try {
    formData = await request.formData();
    const file = formData.get("file");
    const index = formData.get("index");
    const total = formData.get("total");

    if (!file) throw new Error("缺少文件");

    if (enableAuth && !authenticate(request, USERNAME, PASSWORD)) {
      return new Response("Unauthorized", {
        status: 401,
        headers: { "WWW-Authenticate": 'Basic realm="Admin"' },
      });
    }

    const uploadFormData = new FormData();
    uploadFormData.append("chat_id", TG_CHAT_ID);

    if (file.type.startsWith("image/gif")) {
      const newFileName = file.name.replace(/\.gif$/i, ".jpeg");
      const newFile = new File([file], newFileName, { type: "image/jpeg" });
      uploadFormData.append("document", newFile);
    } else {
      uploadFormData.append("document", file);
    }

    const telegramResponse = await fetch(
      `https://api.telegram.org/bot${TG_BOT_TOKEN}/sendDocument`,
      { method: "POST", body: uploadFormData }
    );

    if (!telegramResponse.ok) {
      const errorData = await telegramResponse.json();
      throw new Error(errorData.description || "上传到 Telegram 失败");
    }

    const responseData = await telegramResponse.json();

    let fileId;
    if (responseData.result?.video) fileId = responseData.result.video.file_id;
    else if (responseData.result?.document) fileId = responseData.result.document.file_id;
    else if (responseData.result?.sticker) fileId = responseData.result.sticker.file_id;
    else throw new Error("返回的数据中没有文件 ID");

    const fileExtension = file.name.split(".").pop();
    const timestamp = Date.now();
    const imageURL = `https://${domain}/${timestamp}.${fileExtension}`;

    await DATABASE.prepare(
      "INSERT INTO media (url, fileId, uploaded_at, file_size) VALUES (?, ?, datetime('now'), ?) ON CONFLICT(url) DO NOTHING"
    )
      .bind(imageURL, fileId, file.size)
      .run();

    return new Response(
      JSON.stringify({
        data: imageURL,
        index,
        total,
        success: true,
      }),
      {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      }
    );
  } catch (error) {
    console.error("内部服务器错误:", error);
    return new Response(
      JSON.stringify({
        error: error.message,
        index: formData?.get("index") ?? null,
        total: formData?.get("total") ?? null,
        success: false,
      }),
      {
        status: 500,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      }
    );
  }
}

// ===== 图片/视频请求处理（Telegram转发 + 缓存）=====
async function handleImageRequest(request, DATABASE, TG_BOT_TOKEN) {
  const requestedUrl = request.url;

  const cache = caches.default;
  const cacheKey = new Request(requestedUrl);
  const cachedResponse = await cache.match(cacheKey);
  if (cachedResponse) return cachedResponse;

  const result = await DATABASE.prepare("SELECT fileId FROM media WHERE url = ?")
    .bind(requestedUrl)
    .first();

  if (!result) {
    const notFoundResponse = new Response("资源不存在", { status: 404 });
    await cache.put(cacheKey, notFoundResponse.clone());
    return notFoundResponse;
  }

  const fileId = result.fileId;

  let filePath;
  for (let attempts = 0; attempts < 3; attempts++) {
    const getFilePathResp = await fetch(
      `https://api.telegram.org/bot${TG_BOT_TOKEN}/getFile?file_id=${fileId}`
    );
    if (!getFilePathResp.ok) return new Response("getFile请求失败", { status: 500 });

    const fileData = await getFilePathResp.json();
    if (fileData.ok && fileData.result?.file_path) {
      filePath = fileData.result.file_path;
      break;
    }
  }

  if (!filePath) {
    const notFoundResponse = new Response("未找到FilePath", { status: 404 });
    await cache.put(cacheKey, notFoundResponse.clone());
    return notFoundResponse;
  }

  const tgFileUrl = `https://api.telegram.org/file/bot${TG_BOT_TOKEN}/${filePath}`;
  const response = await fetch(tgFileUrl);
  if (!response.ok) return new Response("获取文件内容失败", { status: 500 });

  const fileExtension = requestedUrl.split(".").pop()?.toLowerCase() || "";
  let contentType = "application/octet-stream";
  if (fileExtension === "jpg" || fileExtension === "jpeg") contentType = "image/jpeg";
  else if (fileExtension === "png") contentType = "image/png";
  else if (fileExtension === "gif") contentType = "image/gif";
  else if (fileExtension === "webp") contentType = "image/webp";
  else if (fileExtension === "mp4") contentType = "video/mp4";

  const headers = new Headers(response.headers);
  headers.set("Content-Type", contentType);
  headers.set("Content-Disposition", "inline");
  headers.set("Cache-Control", "public, max-age=31536000");

  const responseToCache = new Response(response.body, { status: response.status, headers });
  await cache.put(cacheKey, responseToCache.clone());
  return responseToCache;
}

// ===== Bing图片请求（缓存）=====
async function handleBingImagesRequest() {
  const cache = caches.default;
  const cacheKey = new Request("https://cn.bing.com/HPImageArchive.aspx?format=js&idx=0&n=5");

  const cachedResponse = await cache.match(cacheKey);
  if (cachedResponse) return cachedResponse;

  const res = await fetch(cacheKey);
  if (!res.ok) return new Response("请求 Bing API 失败", { status: res.status });

  const bingData = await res.json();
  const images = bingData.images.map((image) => ({ url: `https://cn.bing.com${image.url}` }));

  const returnData = { status: true, message: "操作成功", data: images };

  const response = new Response(JSON.stringify(returnData), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });

  await cache.put(cacheKey, response.clone());
  return response;
}

// ===== 删除图片请求 =====
async function handleDeleteImagesRequest(request, DATABASE, USERNAME, PASSWORD) {
  if (!authenticate(request, USERNAME, PASSWORD)) {
    return new Response("Unauthorized", {
      status: 401,
      headers: { "WWW-Authenticate": 'Basic realm="Admin"' },
    });
  }
  if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405 });

  try {
    const keysToDelete = await request.json();
    if (!Array.isArray(keysToDelete) || keysToDelete.length === 0) {
      return new Response(JSON.stringify({ message: "没有要删除的项" }), { status: 400 });
    }

    const placeholders = keysToDelete.map(() => "?").join(",");
    const result = await DATABASE.prepare(
      `DELETE FROM media WHERE url IN (${placeholders})`
    )
      .bind(...keysToDelete)
      .run();

    if (result.changes === 0) {
      return new Response(JSON.stringify({ message: "未找到要删除的项" }), { status: 404 });
    }

    const cache = caches.default;
    for (const url of keysToDelete) {
      await cache.delete(new Request(url));
    }

    return new Response(JSON.stringify({ message: "删除成功" }), { status: 200 });
  } catch (error) {
    return new Response(JSON.stringify({ error: "删除失败", details: error.message }), { status: 500 });
  }
}

// ===== 移动图片请求 =====
async function handleMoveImagesRequest(request, DATABASE, USERNAME, PASSWORD) {
  if (!authenticate(request, USERNAME, PASSWORD)) {
    return new Response("Unauthorized", {
      status: 401,
      headers: { "WWW-Authenticate": 'Basic realm="Admin"' },
    });
  }
  if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405 });

  try {
    const { urls, folderId } = await request.json();
    if (!Array.isArray(urls) || urls.length === 0) {
      return new Response(JSON.stringify({ message: "没有要移动的文件" }), { status: 400 });
    }

    await Promise.all(
      urls.map((url) =>
        DATABASE.prepare("UPDATE media SET folder_id = ? WHERE url = ?")
          .bind(folderId, url)
          .run()
      )
    );

    return new Response(JSON.stringify({ message: "移动成功" }), { status: 200 });
  } catch (error) {
    return new Response(JSON.stringify({ error: "移动失败", details: error.message }), { status: 500 });
  }
}

// ===== 文件夹请求 =====
async function handleFoldersRequest(request, DATABASE, USERNAME, PASSWORD) {
  if (!authenticate(request, USERNAME, PASSWORD)) {
    return new Response("Unauthorized", {
      status: 401,
      headers: { "WWW-Authenticate": 'Basic realm="Admin"' },
    });
  }
  if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405 });

  try {
    const { action, id, name } = await request.json();

    switch (action) {
      case "create":
        if (!name) return new Response(JSON.stringify({ error: "文件夹名称不能为空" }), { status: 400 });
        await DATABASE.prepare("INSERT INTO folders (name, created_at) VALUES (?, datetime('now'))")
          .bind(name)
          .run();
        break;

      case "update":
        if (!id || !name) return new Response(JSON.stringify({ error: "参数不完整" }), { status: 400 });
        await DATABASE.prepare("UPDATE folders SET name = ? WHERE id = ?").bind(name, id).run();
        break;

      case "delete":
        if (!id) return new Response(JSON.stringify({ error: "参数不完整" }), { status: 400 });
        await DATABASE.prepare("UPDATE media SET folder_id = NULL WHERE folder_id = ?").bind(id).run();
        await DATABASE.prepare("DELETE FROM folders WHERE id = ?").bind(id).run();
        break;

      default:
        return new Response(JSON.stringify({ error: "未知操作" }), { status: 400 });
    }

    return new Response(JSON.stringify({ message: "操作成功" }), { status: 200 });
  } catch (error) {
    return new Response(JSON.stringify({ error: "操作失败", details: error.message }), { status: 500 });
  }
}

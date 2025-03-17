const express = require("express");
const axios = require("axios");
const cors = require("cors");
const path = require("path");
const app = express();
const PORT = 5000;

app.use(cors());
app.use(express.json());

const API_URL = "https://chatglm.cn/chatglm/assistant-api/v1/";
const API_KEY = "1ee756eee1e4b6fd";
const API_SECRET = "e21209e00c1fd7d8f22dec6050b1b059";
const ASSISTANT_ID = "67d6e34dfd43d16b66f987b1";

let accessToken = "";
let tokenExpiresAt = 0;


// 1. 托管前端打包后的 dist 文件夹
app.use(express.static(path.join(__dirname, "dist")));

// 3. 处理除 /api 以外的所有请求，返回 dist/index.html
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "dist", "index.html"));
});


// **获取 Access Token**
async function getAccessToken() {
  try {
    console.log("🔄 正在获取 access_token...");
    const response = await axios.post(`${API_URL}get_token`, {
      api_key: API_KEY,
      api_secret: API_SECRET,
    });

    if (response.data.status === 0 && response.data.result.access_token) {
      accessToken = response.data.result.access_token;
      tokenExpiresAt =
        Date.now() + response.data.result.expires_in * 1000;
      console.log("✅ 获取 access_token 成功:", accessToken);
    } else {
      console.error("❌ 获取 access_token 失败:", response.data);
    }
  } catch (error) {
    console.error(
      "❌ access_token 请求失败:",
      error.response ? error.response.data : error.message
    );
  }
}

// **确保 Access Token 有效**
async function ensureAccessToken() {
  if (!accessToken || Date.now() > tokenExpiresAt) {
    await getAccessToken();
  }
}

// **处理 SSE 数据流**
app.post("/api/chat", async (req, res) => {
  await ensureAccessToken();

  const { prompt } = req.body;
  if (!prompt) {
    return res.status(400).json({ error: "缺少 prompt 参数" });
  }

  try {
    const response = await axios({
      method: "post",
      url: `${API_URL}stream`,
      data: { assistant_id: ASSISTANT_ID, prompt },
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      responseType: "stream",
    });

    // 设置响应头
    res.setHeader("Content-Type", "application/json");

    // 用于拼接完整的消息
    let fullMessage = "";
    // 用于缓存 SSE 数据流的分段
    let buffer = "";
    // 用于比较上一次和本次文本，避免重复
    let lastText = "";

    response.data.on("data", (chunk) => {
      // 将当前流数据转成字符串，拼接到 buffer
      buffer += chunk.toString();

      // 按行分割
      const lines = buffer.split("\n");
      // 最后一行可能是不完整的 JSON 片段，保留到下一次再处理
      buffer = lines.pop();

      for (const line of lines) {
        if (line.startsWith("data: ")) {
          try {
            const jsonString = line.replace("data: ", "").trim();
            if (jsonString) {
              const parsedJson = JSON.parse(jsonString);

              if (
                parsedJson.message &&
                parsedJson.message.content &&
                parsedJson.message.content.text
              ) {
                const newText = parsedJson.message.content.text.trim();

                // 核心去重逻辑：只拼接“增量”部分
                if (newText.startsWith(lastText)) {
                  // 如果 newText 包含了上一次文本作为前缀，只追加多出来的部分
                  const diff = newText.slice(lastText.length);
                  fullMessage += diff;
                } else {
                  // 如果不包含，就直接覆盖（也可以根据需要做更复杂的处理）
                  fullMessage = newText;
                }

                // 更新 lastText
                lastText = newText;
              }
            }
          } catch (e) {
            console.error("⚠️ SSE JSON 解析失败（跳过错误数据）:", e.message);
          }
        }
      }
    });

    // 当数据流结束时，返回拼接好的完整内容
    response.data.on("end", () => {
      res.json({ message: fullMessage.trim() });
    });

  } catch (error) {
    // 如果 access_token 失效，自动重新获取
    if (error.response && error.response.status === 401) {
      console.warn("⚠️ Access Token 失效，正在重新获取...");
      await getAccessToken();
      return res.status(401).json({ error: "Access Token 失效，请重试" });
    }

    console.error(
      "❌ API 请求失败:",
      error.response ? error.response.data : error.message
    );
    res.status(500).json({ error: "服务器请求失败", details: error.message });
  }
});

// **启动服务器**
app.listen(PORT, () => {
  console.log(`🚀 代理服务器运行在端口 ${PORT}`);
  getAccessToken();
});
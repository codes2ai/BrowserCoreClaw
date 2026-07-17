export async function runXiaohongshuProfileInfoPageCommand(command) {
  const normalText = (value) => String(value || "").replace(/\s+/g, " ").trim();
  const isVisible = (element) => {
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity || 1) > 0
      && rect.width > 0 && rect.height > 0;
  };
  const profileIdFromPath = () => {
    const match = String(location.pathname).match(/^\/user\/profile\/([^/?#]+)/i);
    return match?.[1] || "";
  };
  const getProfile = () => {
    const root = document.querySelector(".info-part");
    const interactions = {};
    for (const item of root?.querySelectorAll(".user-interactions > div") || []) {
      const label = normalText(item.querySelector(".shows")?.innerText);
      const value = normalText(item.querySelector(".count")?.innerText);
      if (label && value) interactions[label] = value;
    }
    const tags = [...(root?.querySelectorAll(".user-tags .tag-item") || [])]
      .map((item) => normalText(item.innerText))
      .filter(Boolean);
    const avatar = root?.querySelector(".avatar img, .user-image");
    return {
      profileUrl: location.href,
      profileId: profileIdFromPath(),
      nickname: normalText(root?.querySelector(".user-name")?.innerText),
      xiaohongshuId: normalText(root?.querySelector(".user-redId")?.innerText).replace(/^小红书号\s*[：:]/, ""),
      ipLocation: normalText(root?.querySelector(".user-IP")?.innerText).replace(/^IP属地\s*[：:]/, ""),
      bio: normalText(root?.querySelector(".user-desc")?.innerText),
      tags: tags.join(" · "),
      avatar: avatar?.currentSrc || avatar?.src || "",
      following: interactions.关注 || "",
      followers: interactions.粉丝 || "",
      likedAndCollected: interactions.获赞与收藏 || ""
    };
  };
  const inspect = () => {
    const text = normalText(document.body?.innerText);
    const controls = [...document.querySelectorAll("a, button, [role='button']")]
      .filter(isVisible)
      .map((element) => normalText(element.innerText || element.getAttribute("aria-label") || element.getAttribute("title")))
      .filter(Boolean);
    const profile = getProfile();
    return {
      href: location.href,
      readyState: document.readyState,
      isProfilePage: /^\/user\/profile\/[^/?#]+\/?$/i.test(location.pathname),
      hasProfile: Boolean(document.querySelector(".info-part") && (profile.nickname || profile.xiaohongshuId)),
      profileSignature: [profile.nickname, profile.xiaohongshuId, profile.followers, profile.likedAndCollected].join("|"),
      hasLoginEntry: controls.some((label) => /登录|登入/.test(label)),
      captcha: /验证码|安全验证|人机验证|访问过于频繁/.test(text)
    };
  };

  if (command === "inspect") return inspect();
  if (command === "extract") return {
    profile: getProfile(),
    capturedAt: new Date().toISOString(),
    pageUrl: location.href,
    rawPageText: String(document.body?.innerText || "").trim()
  };
  throw new Error(`未知的小红书博主信息页面命令：${command}`);
}

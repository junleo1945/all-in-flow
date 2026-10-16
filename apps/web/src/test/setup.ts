// 测试默认使用中文界面：浏览器语言在 jsdom 里是英文，这里固定住，避免断言中文文案的用例受影响
try {
  localStorage.setItem("aif-locale", "zh");
} catch {
  /* jsdom 下正常可用，这里只是兜底 */
}

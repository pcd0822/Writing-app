import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // COOP를 켜두면 Firebase 팝업이 window.close() 할 때 브라우저 경고가 날 수 있어 기본(헤더 없음)으로 둡니다.
};

export default nextConfig;

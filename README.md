# 台灣旅遊護照

匯入照片或 Google 時間軸，看看你走過台灣的哪些地方，解鎖縣市、鄉鎮、村里、百岳、車站、離島與國家公園成就。

🔒 **本機運算**：所有計算都在你的瀏覽器內完成，照片與位置資料不會上傳到任何地方。本網站不使用任何追蹤或分析工具。

👉 網站：<https://victorchen1017.github.io/taiwan_travel_passport/>

📖 使用說明：<https://victorchen1017.github.io/taiwan_travel_passport/help.html>

## 自己架架看

純靜態網站、沒有後端，可以在自己的電腦跑：

1. **Code → Download ZIP**，解壓縮
2. 在資料夾裡執行 `python -m http.server 8000`
3. 打開 <http://localhost:8000/>

驗證：開發者工具「網路」分頁裡，只會看到本站檔案與 OpenStreetMap 圖磚。

規格與開發紀錄見 [docs/SPEC.md](docs/SPEC.md)。

（由「手搓迷霧」照片地圖平台的迷霧探索成就頁改寫而成。）

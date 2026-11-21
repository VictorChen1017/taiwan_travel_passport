// 裝置判斷：全站唯一的「手機／電腦」判斷來源，其他檔案一律 import 這裡，不要自己寫 matchMedia。
//
// 「手機／電腦」分兩件事，各用各的判斷，不要混用：
//
// 1. 用手指還是滑鼠（輸入方式）→ 本檔的 TOUCH、CAN_HOVER
//    決定：寫「點一下」還是「滑過」、滑過提示要不要改成點擊泡泡、要不要叫出系統分享選單、手機專用卡片
//    CSS 對應：@media (pointer: coarse) ＝ TOUCH；@media (hover: hover) ＝ CAN_HOVER（:hover 樣式一律包在裡面，手機點過才不會黏住）
//    文字依裝置切換：HTML 用 <span class="only-touch">點一下</span><span class="only-mouse">滑過</span>（css/app.css）；JS 用 tapWord()
//
// 2. 畫面寬或窄（版面）→ 只在 CSS 用 @media (max-width: …)，固定三個分界，不要新增其他數字：
//    640px  手機：單欄、頂列只留圖示
//    900px  平板：目錄改抽屜、彈窗上下排列
//    1200px 窄電腦：內容欄數減少、頂列按鈕只留圖示
//    （字級另外在 1200px、1600px 以上放大，見 css/app.css 開頭 --fs）
//    平板是觸控但畫面寬、電腦視窗拉窄是滑鼠但畫面窄，所以版面不看 TOUCH，提示文字不看寬度。

const mq = q => typeof matchMedia === 'function' && matchMedia(q).matches;

/** 主要輸入是手指（手機、平板） */
export const TOUCH = mq('(pointer: coarse)');

/** 有滑鼠可以滑過（電腦；平板接滑鼠也算） */
export const CAN_HOVER = mq('(hover: hover)');

/** 提示用語：觸控寫「點一下」，滑鼠寫「滑過」 */
export const tapWord = () => (TOUCH ? '點一下' : '滑過');

/** 觸控且瀏覽器能分享這個檔案：用系統分享選單（可傳到 App 或存到相簿）；電腦一律下載 */
export function canShareFile(file = new File([''], 'a.png', { type: 'image/png' })) {
    try { return !!(TOUCH && navigator.canShare && navigator.canShare({ files: [file] })); } catch (e) { return false; }
}

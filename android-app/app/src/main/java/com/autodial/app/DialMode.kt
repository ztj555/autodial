package com.autodial.app

/**
 * 拨号卡选择模式
 */
enum class DialMode(val label: String, val key: String, val desc: String) {
    /** 每次拨号弹出自定义选卡卡片，用户手动选择 */
    POPUP("弹窗选卡", "popup", "每次拨号都弹出卡片让您选择用哪张卡"),
    /** 未被对比通话记录识别→按循环模式；已识别→弹窗让用户选择 */
    ROUND_SELECT("智能轮选", "round_select", "10天内打过→弹窗选卡；10天外→循环轮选"),
    /** 相反模式：仅对2天内的通话记录做相反；超过2天的按弹窗处理 */
    OPPOSITE("相反", "opposite", "2天内自动反向选卡，超过2天按轮选处理"),
    /** 始终使用卡1 */
    SIM1("卡1", "sim1", "始终使用SIM卡1拨号"),
    /** 始终使用卡2 */
    SIM2("卡2", "sim2", "始终使用SIM卡2拨号"),
    /** 卡1→卡2→卡1全局交替 */
    ALTERNATE("循环", "alternate", "每次拨号自动切换：卡1→卡2→卡1→卡2"),
    /** 系统选择器 */
    SYSTEM("系统默认", "system", "由手机系统自带的选择器决定，APP不做干预");

    companion object {
        fun fromKey(key: String): DialMode =
            entries.firstOrNull { it.key == key } ?: POPUP
    }
}

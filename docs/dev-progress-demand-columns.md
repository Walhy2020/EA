# 需求总表字段清单

更新时间：2026-06-11
来源：企业微信智能表格「【新】Eazygame需求总表」
当前版本：0.5.65

## 读取结果

- 字段总数：100
- 当前字段映射数：28
- 当前必填规则引用字段数：34
- 字段映射缺失：0
- 必填规则引用缺失：0
- 注意：旧探测逻辑最多只展示 80 列，已调整为最多展示 500 列，并返回接口 total/hasMore/next。

## 所有字段

| 序号 | 字段名 | 字段类型 |
|---:|---|---|
| 1 | 需求Id | FIELD_TYPE_AUTONUMBER |
| 2 | 项目 | FIELD_TYPE_SINGLE_SELECT |
| 3 | 需求类型 | FIELD_TYPE_SINGLE_SELECT |
| 4 | 需求名称 | FIELD_TYPE_TEXT |
| 5 | 需求内容 | FIELD_TYPE_TEXT |
| 6 | 截图 | FIELD_TYPE_IMAGE |
| 7 | 录屏 | FIELD_TYPE_ATTACHMENT |
| 8 | 需求进度 | FIELD_TYPE_SINGLE_SELECT |
| 9 | 规模类型 | FIELD_TYPE_TWOWAYLINKRECORDS |
| 10 | 更新时间 | FIELD_TYPE_DATE_TIME |
| 11 | 监修时间 | FIELD_TYPE_DATE_TIME |
| 12 | 需求截止日期 | FIELD_TYPE_FORMULA |
| 13 | 配置截止日期 | FIELD_TYPE_FORMULA |
| 14 | 策划人员 | FIELD_TYPE_USER |
| 15 | UI人员 | FIELD_TYPE_USER |
| 16 | UI完成时间 | FIELD_TYPE_DATE_TIME |
| 17 | 优先级 | FIELD_TYPE_SINGLE_SELECT |
| 18 | 提出人 | FIELD_TYPE_USER |
| 19 | 需求链接 | FIELD_TYPE_URL |
| 20 | 一键建群 | FIELD_TYPE_CHECKBOX |
| 21 | 群聊 | FIELD_TYPE_WWGROUP |
| 22 | 备注 | FIELD_TYPE_TEXT |
| 23 | 前端开发 | FIELD_TYPE_USER |
| 24 | 后端开发 | FIELD_TYPE_USER |
| 25 | 前端耗时 | FIELD_TYPE_NUMBER |
| 26 | 前端剩余 | FIELD_TYPE_NUMBER |
| 27 | 后端耗时 | FIELD_TYPE_TEXT |
| 28 | 后端剩余 | FIELD_TYPE_NUMBER |
| 29 | 程序备注 | FIELD_TYPE_TEXT |
| 30 | 前端组长 | FIELD_TYPE_LOOKUP |
| 31 | 后端组长 | FIELD_TYPE_LOOKUP |
| 32 | 测试人员 | FIELD_TYPE_USER |
| 33 | UI需求 | FIELD_TYPE_TEXT |
| 34 | 动效需求 | FIELD_TYPE_TEXT |
| 35 | 动效人员 | FIELD_TYPE_USER |
| 36 | UI进度 | FIELD_TYPE_SINGLE_SELECT |
| 37 | 动效进度 | FIELD_TYPE_SINGLE_SELECT |
| 38 | 复盘情况 | FIELD_TYPE_SINGLE_SELECT |
| 39 | 创建时间 | FIELD_TYPE_DATE_TIME |
| 40 | 实际上线日期 | FIELD_TYPE_DATE_TIME |
| 41 | UI耗时 | FIELD_TYPE_USER |
| 42 | UI日方时间 | FIELD_TYPE_DATE_TIME |
| 43 | UI剩余时间 | FIELD_TYPE_SINGLE_SELECT |
| 44 | 开始时间 | FIELD_TYPE_DATE_TIME |
| 45 | 美术截止日期 | FIELD_TYPE_FORMULA |
| 46 | 监修截止日期 | FIELD_TYPE_FORMULA |
| 47 | 开发截止日期 | FIELD_TYPE_FORMULA |
| 48 | 验收截止日期 | FIELD_TYPE_FORMULA |
| 49 | 测试截止日期 | FIELD_TYPE_FORMULA |
| 50 | 内网测试方式 | FIELD_TYPE_SINGLE_SELECT |
| 51 | 功能所属模块（一骑专用） | FIELD_TYPE_SINGLE_SELECT |
| 52 | 更新未测试 | FIELD_TYPE_SINGLE_SELECT |
| 53 | 开发完成月份 | FIELD_TYPE_SINGLE_SELECT |
| 54 | 关联需求 | FIELD_TYPE_REFERENCE |
| 55 | 前端AI含量 | FIELD_TYPE_SINGLE_SELECT |
| 56 | 后端AI含量 | FIELD_TYPE_SINGLE_SELECT |
| 57 | 前端_周 | FIELD_TYPE_DATE_TIME |
| 58 | 后端_周 | FIELD_TYPE_DATE_TIME |
| 59 | UI开始时间 | FIELD_TYPE_DATE_TIME |
| 60 | 执行状态 | FIELD_TYPE_SINGLE_SELECT |
| 61 | 异常 | FIELD_TYPE_SELECT |
| 62 | 需求设计耗时 | FIELD_TYPE_NUMBER |
| 63 | 需求设计剩余 | FIELD_TYPE_NUMBER |
| 64 | 需求设计交付日期 | FIELD_TYPE_DATE_TIME |
| 65 | 数值耗时 | FIELD_TYPE_NUMBER |
| 66 | 数值剩余 | FIELD_TYPE_NUMBER |
| 67 | 配置耗时 | FIELD_TYPE_NUMBER |
| 68 | 配置剩余 | FIELD_TYPE_NUMBER |
| 69 | UI制作耗时 | FIELD_TYPE_NUMBER |
| 70 | UI制作剩余 | FIELD_TYPE_NUMBER |
| 71 | 动效制作耗时 | FIELD_TYPE_NUMBER |
| 72 | 动效制作剩余 | FIELD_TYPE_NUMBER |
| 73 | 程序前端耗时 | FIELD_TYPE_NUMBER |
| 74 | 程序前端剩余 | FIELD_TYPE_NUMBER |
| 75 | 程序后端耗时 | FIELD_TYPE_NUMBER |
| 76 | 程序后端剩余 | FIELD_TYPE_NUMBER |
| 77 | 内网验收耗时 | FIELD_TYPE_NUMBER |
| 78 | 内网验收剩余 | FIELD_TYPE_NUMBER |
| 79 | 内网测试耗时 | FIELD_TYPE_NUMBER |
| 80 | 内网测试剩余 | FIELD_TYPE_NUMBER |
| 81 | 测试1验收/测试耗时 | FIELD_TYPE_NUMBER |
| 82 | 测试1验收/测试剩余 | FIELD_TYPE_NUMBER |
| 83 | 测试2验收耗时 | FIELD_TYPE_NUMBER |
| 84 | 测试2验收剩余 | FIELD_TYPE_NUMBER |
| 85 | UI制作交付日期 | FIELD_TYPE_DATE_TIME |
| 86 | UI监修完成日期 | FIELD_TYPE_DATE_TIME |
| 87 | 动效制作交付日期 | FIELD_TYPE_DATE_TIME |
| 88 | 动效监修完成日期 | FIELD_TYPE_DATE_TIME |
| 89 | 程序开发完成日期 | FIELD_TYPE_DATE_TIME |
| 90 | 内网验收完成日期 | FIELD_TYPE_DATE_TIME |
| 91 | 内网测试完成日期 | FIELD_TYPE_DATE_TIME |
| 92 | 测试1验收/测试完成日期 | FIELD_TYPE_DATE_TIME |
| 93 | 测试2验收完成日期 | FIELD_TYPE_DATE_TIME |
| 94 | 测试2测试完成日期 | FIELD_TYPE_DATE_TIME |
| 95 | 测试2测试耗时 | FIELD_TYPE_NUMBER |
| 96 | 测试2测试剩余 | FIELD_TYPE_NUMBER |
| 97 | 策划组长 | FIELD_TYPE_USER |
| 98 | UI组长 | FIELD_TYPE_USER |
| 99 | 动效组长 | FIELD_TYPE_USER |
| 100 | 测试组长 | FIELD_TYPE_USER |

## 当前核心映射

| 内部字段 | 需求总表字段 |
|---|---|
| demandId | 需求Id |
| project | 项目 |
| demand | 需求名称 |
| demandContent | 需求内容 |
| demandType | 需求类型 |
| owner | 前端开发 |
| status | 需求进度 |
| progress | 需求进度 |
| planDate | 开发截止日期 |
| blockers | 程序备注 |
| updatedAt | 更新时间 |
| remarks | 备注 |
| frontendOwner | 前端开发 |
| backendOwner | 后端开发 |
| frontendRemaining | 前端剩余 |
| backendRemaining | 后端剩余 |
| uiOwner | UI人员 |
| plannerOwner | 策划人员 |
| testerOwner | 测试人员 |
| effectOwner | 动效人员 |
| frontendLead | 前端组长 |
| backendLead | 后端组长 |
| devDeadline | 开发截止日期 |
| testDeadline | 测试截止日期 |
| acceptanceDeadline | 验收截止日期 |
| releaseDate | 实际上线日期 |
| groupChat | 群聊 |
| demandLink | 需求链接 |

## 给机器人创建需求的初步分层

### 必填基础字段

需求类型、项目、需求名称、需求内容、需求进度、策划人员、更新时间。

### 建议创建时收集

优先级、提出人、需求链接、规模类型、备注、截图、录屏、关联需求。

### 进入开发阶段后补充

前端开发、后端开发、前端组长、后端组长、开发截止日期、前端耗时、前端剩余、后端耗时、后端剩余、程序备注、内网测试方式、群聊。

### UI/动效相关

UI需求、UI人员、UI进度、UI开始时间、UI完成时间、UI耗时、UI剩余时间、UI日方时间、UI制作耗时、UI制作剩余、UI制作交付日期、UI监修完成日期、动效需求、动效人员、动效进度、动效制作耗时、动效制作剩余、动效制作交付日期、动效监修完成日期、UI组长、动效组长。

### 测试/验收/上线相关

测试人员、测试截止日期、验收截止日期、实际上线日期、内网验收耗时、内网验收剩余、内网测试耗时、内网测试剩余、内网验收完成日期、内网测试完成日期、测试1验收/测试耗时、测试1验收/测试剩余、测试1验收/测试完成日期、测试2验收耗时、测试2验收剩余、测试2验收完成日期、测试2测试耗时、测试2测试剩余、测试2测试完成日期、测试组长。

### 统计/辅助字段

需求截止日期、配置截止日期、美术截止日期、监修截止日期、监修时间、复盘情况、创建时间、开始时间、功能所属模块（一骑专用）、更新未测试、开发完成月份、前端AI含量、后端AI含量、前端_周、后端_周、执行状态、异常、需求设计耗时、需求设计剩余、需求设计交付日期、数值耗时、数值剩余、配置耗时、配置剩余、程序前端耗时、程序前端剩余、程序后端耗时、程序后端剩余。

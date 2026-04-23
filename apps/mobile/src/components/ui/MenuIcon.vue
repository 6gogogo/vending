<script setup lang="ts">
type MenuIconName =
  | "review"
  | "users"
  | "device"
  | "logs"
  | "template"
  | "restock"
  | "trace"
  | "feedback"
  | "guide"
  | "nearby"
  | "scan"
  | "settings"
  | "logout"
  | "desktop";

type MenuIconTone = "accent" | "neutral" | "contrast" | "warning";
type MenuIconSize = "sm" | "md" | "lg";

withDefaults(
  defineProps<{
    name: MenuIconName;
    tone?: MenuIconTone;
    size?: MenuIconSize;
  }>(),
  {
    tone: "accent",
    size: "md"
  }
);
</script>

<template>
  <view class="menu-icon" :class="[`menu-icon--${tone}`, `menu-icon--${size}`]" aria-hidden="true">
    <template v-if="name === 'review'">
      <view class="menu-icon__outline review__sheet" />
      <view class="menu-icon__line review__line review__line--1" />
      <view class="menu-icon__line review__line review__line--2" />
      <view class="menu-icon__line review__tick review__tick--1" />
      <view class="menu-icon__line review__tick review__tick--2" />
    </template>

    <template v-else-if="name === 'users'">
      <view class="menu-icon__outline users__head users__head--left" />
      <view class="menu-icon__outline users__head users__head--right" />
      <view class="menu-icon__fill users__body users__body--left" />
      <view class="menu-icon__fill users__body users__body--right" />
    </template>

    <template v-else-if="name === 'device'">
      <view class="menu-icon__outline device__body" />
      <view class="menu-icon__line device__slot" />
      <view class="menu-icon__line device__shelf device__shelf--top" />
      <view class="menu-icon__line device__shelf device__shelf--bottom" />
      <view class="menu-icon__dot device__indicator" />
    </template>

    <template v-else-if="name === 'logs'">
      <view class="menu-icon__outline logs__sheet" />
      <view class="menu-icon__line logs__line logs__line--1" />
      <view class="menu-icon__line logs__line logs__line--2" />
      <view class="menu-icon__line logs__line logs__line--3" />
    </template>

    <template v-else-if="name === 'template'">
      <view class="menu-icon__outline template__sheet template__sheet--back" />
      <view class="menu-icon__outline template__sheet template__sheet--front" />
      <view class="menu-icon__line template__line template__line--1" />
      <view class="menu-icon__line template__line template__line--2" />
    </template>

    <template v-else-if="name === 'restock'">
      <view class="menu-icon__outline restock__box" />
      <view class="menu-icon__line restock__lid restock__lid--left" />
      <view class="menu-icon__line restock__lid restock__lid--right" />
      <view class="menu-icon__fill restock__badge" />
      <view class="menu-icon__line restock__plus restock__plus--h" />
      <view class="menu-icon__line restock__plus restock__plus--v" />
    </template>

    <template v-else-if="name === 'trace'">
      <view class="menu-icon__line trace__path trace__path--first" />
      <view class="menu-icon__line trace__path trace__path--second" />
      <view class="menu-icon__dot trace__node trace__node--start" />
      <view class="menu-icon__dot trace__node trace__node--middle" />
      <view class="menu-icon__dot trace__node trace__node--end" />
    </template>

    <template v-else-if="name === 'feedback'">
      <view class="menu-icon__outline feedback__bubble" />
      <view class="menu-icon__fill feedback__tail" />
      <view class="menu-icon__line feedback__line feedback__line--1" />
      <view class="menu-icon__line feedback__line feedback__line--2" />
    </template>

    <template v-else-if="name === 'guide'">
      <view class="menu-icon__outline guide__book" />
      <view class="menu-icon__line guide__spine" />
      <view class="menu-icon__line guide__line guide__line--1" />
      <view class="menu-icon__line guide__line guide__line--2" />
      <view class="menu-icon__fill guide__bookmark" />
    </template>

    <template v-else-if="name === 'nearby'">
      <view class="menu-icon__outline nearby__pin" />
      <view class="menu-icon__dot nearby__dot" />
    </template>

    <template v-else-if="name === 'scan'">
      <view class="scan__corner scan__corner--tl" />
      <view class="scan__corner scan__corner--tr" />
      <view class="scan__corner scan__corner--bl" />
      <view class="scan__corner scan__corner--br" />
      <view class="menu-icon__fill scan__center" />
    </template>

    <template v-else-if="name === 'settings'">
      <view class="menu-icon__line settings__line settings__line--1" />
      <view class="menu-icon__line settings__line settings__line--2" />
      <view class="menu-icon__line settings__line settings__line--3" />
      <view class="menu-icon__dot settings__knob settings__knob--1" />
      <view class="menu-icon__dot settings__knob settings__knob--2" />
      <view class="menu-icon__dot settings__knob settings__knob--3" />
    </template>

    <template v-else-if="name === 'logout'">
      <view class="menu-icon__outline logout__sign" />
      <view class="menu-icon__outline logout__door" />
      <view class="menu-icon__dot logout__head" />
      <view class="menu-icon__line logout__torso" />
      <view class="menu-icon__line logout__arm" />
      <view class="menu-icon__line logout__leg logout__leg--front" />
      <view class="menu-icon__line logout__leg logout__leg--back" />
      <view class="menu-icon__line logout__arrow logout__arrow--body" />
      <view class="menu-icon__line logout__arrow logout__arrow--top" />
      <view class="menu-icon__line logout__arrow logout__arrow--bottom" />
    </template>

    <template v-else-if="name === 'desktop'">
      <view class="menu-icon__outline desktop__screen" />
      <view class="menu-icon__line desktop__stand desktop__stand--stem" />
      <view class="menu-icon__line desktop__stand desktop__stand--base" />
    </template>
  </view>
</template>

<style scoped>
.menu-icon {
  --menu-icon-fill: rgba(255, 255, 255, 0.72);
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  overflow: hidden;
  border-radius: 22rpx;
  color: var(--vm-accent-strong);
}

.menu-icon--sm {
  width: 44rpx;
  height: 44rpx;
  border-radius: 14rpx;
}

.menu-icon--md {
  width: 68rpx;
  height: 68rpx;
  border-radius: 20rpx;
}

.menu-icon--lg {
  width: 76rpx;
  height: 76rpx;
  border-radius: 22rpx;
}

.menu-icon--accent {
  background: var(--vm-accent-soft);
  border: 1rpx solid var(--vm-accent-line);
  color: var(--vm-accent-strong);
}

.menu-icon--neutral {
  background: var(--vm-surface-soft);
  border: 1rpx solid var(--vm-line-strong);
  color: var(--vm-text);
}

.menu-icon--contrast {
  --menu-icon-fill: rgba(255, 255, 255, 0.14);
  background: rgba(255, 255, 255, 0.14);
  border: 1rpx solid rgba(255, 255, 255, 0.26);
  color: #ffffff;
}

.menu-icon--warning {
  background: var(--vm-warning-soft);
  border: 1rpx solid var(--vm-warning-line);
  color: var(--vm-warning);
}

.vm-page--accessible .menu-icon--accent,
.vm-page--accessible .menu-icon--neutral,
.vm-page--accessible .menu-icon--warning {
  border-width: 3rpx;
}

.vm-page--accessible .menu-icon--accent {
  background: var(--vm-info-bg);
  border-color: var(--vm-info-line);
  color: var(--vm-info);
}

.vm-page--accessible .menu-icon--neutral {
  background: #ffffff;
  border-color: var(--vm-line-strong);
}

.vm-page--accessible .menu-icon--warning {
  background: var(--vm-warning-bg);
}

.menu-icon__outline,
.menu-icon__line,
.menu-icon__dot,
.menu-icon__fill,
.scan__corner {
  position: absolute;
  box-sizing: border-box;
}

.menu-icon__outline {
  border: 3rpx solid currentColor;
  background: var(--menu-icon-fill);
}

.menu-icon__line,
.menu-icon__fill {
  background: currentColor;
  border-radius: 999rpx;
}

.menu-icon__dot {
  background: currentColor;
  border-radius: 50%;
}

.review__sheet,
.logs__sheet,
.template__sheet--front {
  width: 48%;
  height: 60%;
  left: 26%;
  top: 20%;
  border-radius: 20%;
}

.review__line {
  left: 38%;
  width: 18%;
  height: 4rpx;
}

.review__line--1 {
  top: 35%;
}

.review__line--2 {
  top: 46%;
}

.review__tick {
  height: 4rpx;
}

.review__tick--1 {
  width: 10%;
  left: 38%;
  top: 58%;
  transform: rotate(46deg);
}

.review__tick--2 {
  width: 20%;
  left: 45%;
  top: 54%;
  transform: rotate(-40deg);
}

.users__head {
  width: 18%;
  height: 18%;
  border-radius: 50%;
  background: transparent;
}

.users__head--left {
  left: 23%;
  top: 24%;
}

.users__head--right {
  left: 50%;
  top: 20%;
}

.users__body {
  height: 12%;
  border-radius: 999rpx 999rpx 22% 22%;
}

.users__body--left {
  width: 28%;
  left: 19%;
  top: 54%;
}

.users__body--right {
  width: 26%;
  left: 48%;
  top: 50%;
}

.device__body {
  width: 52%;
  height: 62%;
  left: 24%;
  top: 19%;
  border-radius: 18%;
}

.device__slot {
  width: 18%;
  height: 4rpx;
  left: 41%;
  top: 28%;
}

.device__shelf {
  width: 34%;
  height: 4rpx;
  left: 33%;
}

.device__shelf--top {
  top: 42%;
}

.device__shelf--bottom {
  top: 56%;
}

.device__indicator {
  width: 10%;
  height: 10%;
  right: 29%;
  bottom: 24%;
}

.logs__sheet {
  border-radius: 18%;
}

.logs__line,
.template__line {
  width: 20%;
  height: 4rpx;
  left: 38%;
}

.logs__line--1,
.template__line--1 {
  top: 35%;
}

.logs__line--2,
.template__line--2 {
  top: 47%;
}

.logs__line--3 {
  top: 59%;
}

.template__sheet--back {
  width: 42%;
  height: 54%;
  left: 21%;
  top: 24%;
  border-radius: 18%;
  opacity: 0.7;
}

.template__sheet--front {
  left: 33%;
}

.restock__box {
  width: 48%;
  height: 38%;
  left: 26%;
  top: 38%;
  border-radius: 18%;
  background: transparent;
}

.restock__lid {
  width: 18%;
  height: 4rpx;
  top: 34%;
}

.restock__lid--left {
  left: 26%;
  transform: rotate(26deg);
}

.restock__lid--right {
  right: 26%;
  transform: rotate(-26deg);
}

.restock__badge {
  width: 24%;
  height: 24%;
  right: 16%;
  top: 14%;
  border-radius: 50%;
}

.restock__plus {
  background: #ffffff;
  z-index: 1;
}

.restock__plus--h {
  width: 12%;
  height: 4rpx;
  right: 22%;
  top: 25%;
}

.restock__plus--v {
  width: 4rpx;
  height: 12%;
  right: 28%;
  top: 19%;
}

.trace__path {
  height: 4rpx;
  top: 50%;
  transform-origin: left center;
}

.trace__path--first {
  width: 22%;
  left: 24%;
  transform: rotate(18deg);
}

.trace__path--second {
  width: 24%;
  left: 47%;
  transform: rotate(-22deg);
}

.trace__node {
  width: 10%;
  height: 10%;
}

.trace__node--start {
  left: 18%;
  top: 55%;
}

.trace__node--middle {
  left: 45%;
  top: 42%;
}

.trace__node--end {
  right: 18%;
  top: 58%;
}

.feedback__bubble {
  width: 56%;
  height: 44%;
  left: 22%;
  top: 24%;
  border-radius: 28%;
}

.feedback__tail {
  width: 16%;
  height: 16%;
  left: 34%;
  top: 58%;
  transform: rotate(45deg);
}

.feedback__line {
  width: 18%;
  height: 4rpx;
  left: 39%;
}

.feedback__line--1 {
  top: 39%;
}

.feedback__line--2 {
  top: 50%;
}

.guide__book {
  width: 56%;
  height: 62%;
  left: 22%;
  top: 18%;
  border-radius: 16%;
}

.guide__spine {
  width: 4rpx;
  height: 46%;
  left: 40%;
  top: 26%;
}

.guide__line {
  width: 18%;
  height: 4rpx;
  left: 49%;
}

.guide__line--1 {
  top: 37%;
}

.guide__line--2 {
  top: 49%;
}

.guide__bookmark {
  width: 10%;
  height: 18%;
  left: 56%;
  top: 18%;
  border-radius: 0 0 8rpx 8rpx;
}

.nearby__pin {
  width: 38%;
  height: 38%;
  left: 31%;
  top: 20%;
  border-radius: 50% 50% 50% 0;
  transform: rotate(-45deg);
  background: transparent;
}

.nearby__dot {
  width: 10%;
  height: 10%;
  left: 45%;
  top: 33%;
}

.scan__corner {
  width: 18%;
  height: 18%;
  border-color: currentColor;
}

.scan__corner--tl {
  left: 18%;
  top: 18%;
  border-left: 3rpx solid currentColor;
  border-top: 3rpx solid currentColor;
  border-top-left-radius: 12rpx;
}

.scan__corner--tr {
  right: 18%;
  top: 18%;
  border-right: 3rpx solid currentColor;
  border-top: 3rpx solid currentColor;
  border-top-right-radius: 12rpx;
}

.scan__corner--bl {
  left: 18%;
  bottom: 18%;
  border-left: 3rpx solid currentColor;
  border-bottom: 3rpx solid currentColor;
  border-bottom-left-radius: 12rpx;
}

.scan__corner--br {
  right: 18%;
  bottom: 18%;
  border-right: 3rpx solid currentColor;
  border-bottom: 3rpx solid currentColor;
  border-bottom-right-radius: 12rpx;
}

.scan__center {
  width: 12%;
  height: 12%;
  left: 44%;
  top: 44%;
  border-radius: 20%;
}

.settings__line {
  width: 48%;
  height: 4rpx;
  left: 26%;
}

.settings__line--1 {
  top: 31%;
}

.settings__line--2 {
  top: 48%;
}

.settings__line--3 {
  top: 65%;
}

.settings__knob {
  width: 12%;
  height: 12%;
}

.settings__knob--1 {
  left: 28%;
  top: 25%;
}

.settings__knob--2 {
  left: 53%;
  top: 42%;
}

.settings__knob--3 {
  left: 39%;
  top: 59%;
}

.logout__sign {
  width: 58%;
  height: 58%;
  left: 18%;
  top: 21%;
  border-radius: 16%;
  background: var(--vm-accent-strong);
  border-color: var(--vm-accent);
}

.logout__door {
  width: 10%;
  height: 28%;
  right: 25%;
  top: 36%;
  border-radius: 8rpx;
  background: transparent;
  border-color: #ffffff;
}

.logout__head {
  width: 8%;
  height: 8%;
  left: 31%;
  top: 34%;
  background: #ffffff;
}

.logout__torso,
.logout__arm,
.logout__leg {
  height: 4rpx;
  transform-origin: right center;
  background: #ffffff;
}

.logout__torso {
  width: 14%;
  left: 30%;
  top: 48%;
  transform: rotate(48deg);
}

.logout__arm {
  width: 10%;
  left: 27%;
  top: 50%;
  transform: rotate(18deg);
}

.logout__leg {
  width: 12%;
}

.logout__leg--front {
  left: 36%;
  top: 60%;
  transform: rotate(-28deg);
}

.logout__leg--back {
  left: 28%;
  top: 60%;
  transform: rotate(24deg);
}

.logout__arrow {
  height: 4rpx;
  right: 18%;
  background: #ffffff;
  transform-origin: right center;
}

.logout__arrow--body {
  width: 12%;
  top: 49%;
}

.logout__arrow--top {
  width: 8%;
  top: 41%;
  transform: rotate(36deg);
}

.logout__arrow--bottom {
  width: 8%;
  top: 57%;
  transform: rotate(-36deg);
}

.desktop__screen {
  width: 54%;
  height: 40%;
  left: 23%;
  top: 22%;
  border-radius: 16%;
}

.desktop__stand {
  left: 50%;
  transform: translateX(-50%);
}

.desktop__stand--stem {
  width: 4rpx;
  height: 12%;
  top: 62%;
}

.desktop__stand--base {
  width: 22%;
  height: 4rpx;
  top: 76%;
}
</style>

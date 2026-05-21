<template>
  <view class="cabinet-art" aria-hidden="true">
    <view class="cabinet-art__sun" />
    <view class="cabinet-art__hill cabinet-art__hill--back" />
    <view class="cabinet-art__hill cabinet-art__hill--front" />
    <view class="cabinet-art__heart cabinet-art__heart--left" />
    <view class="cabinet-art__heart cabinet-art__heart--right" />
    <view class="cabinet-art__cabinet">
      <view class="cabinet-art__screen">
        <view class="cabinet-art__shelf cabinet-art__shelf--top">
          <view class="cabinet-art__goods cabinet-art__goods--green" />
          <view class="cabinet-art__goods cabinet-art__goods--orange" />
          <view class="cabinet-art__goods cabinet-art__goods--cream" />
        </view>
        <view class="cabinet-art__shelf cabinet-art__shelf--middle">
          <view class="cabinet-art__goods cabinet-art__goods--orange" />
          <view class="cabinet-art__goods cabinet-art__goods--cream" />
          <view class="cabinet-art__goods cabinet-art__goods--green" />
        </view>
        <view class="cabinet-art__shelf cabinet-art__shelf--bottom">
          <view class="cabinet-art__goods cabinet-art__goods--cream" />
          <view class="cabinet-art__goods cabinet-art__goods--green" />
          <view class="cabinet-art__goods cabinet-art__goods--orange" />
        </view>
      </view>
      <view class="cabinet-art__panel">
        <view class="cabinet-art__scan" />
        <view class="cabinet-art__button" />
      </view>
    </view>
    <view class="cabinet-art__person">
      <view class="cabinet-art__person-head" />
      <view class="cabinet-art__person-body" />
    </view>
  </view>
</template>

<style scoped>
.cabinet-art {
  position: relative;
  min-height: 250rpx;
  overflow: hidden;
  border-radius: 28rpx;
  background:
    linear-gradient(180deg, rgba(255, 247, 236, 0.3), rgba(232, 244, 223, 0.75)),
    #fff9f1;
}

.cabinet-art__sun {
  position: absolute;
  top: 34rpx;
  left: 46rpx;
  width: 74rpx;
  height: 74rpx;
  border-radius: 50%;
  background: #ffe2b6;
}

.cabinet-art__hill {
  position: absolute;
  left: -10%;
  right: -10%;
  border-radius: 50% 50% 0 0;
}

.cabinet-art__hill--back {
  bottom: 28rpx;
  height: 110rpx;
  background: #e7f3db;
}

.cabinet-art__hill--front {
  bottom: -44rpx;
  height: 150rpx;
  background: #d5eccb;
}

.cabinet-art__heart,
.cabinet-art__heart::before,
.cabinet-art__heart::after {
  position: absolute;
  width: 28rpx;
  height: 28rpx;
  background: #ff9a33;
}

.cabinet-art__heart {
  transform: rotate(45deg);
  opacity: 0.82;
}

.cabinet-art__heart::before,
.cabinet-art__heart::after {
  content: "";
  border-radius: 50%;
}

.cabinet-art__heart::before {
  left: -14rpx;
}

.cabinet-art__heart::after {
  top: -14rpx;
}

.cabinet-art__heart--left {
  left: 92rpx;
  top: 132rpx;
}

.cabinet-art__heart--right {
  right: 88rpx;
  top: 54rpx;
  transform: rotate(45deg) scale(0.72);
  background: #ffb764;
}

.cabinet-art__heart--right::before,
.cabinet-art__heart--right::after {
  background: #ffb764;
}

.cabinet-art__cabinet {
  position: absolute;
  right: 86rpx;
  bottom: 36rpx;
  width: 138rpx;
  height: 188rpx;
  border-radius: 18rpx;
  background: #2e7d46;
  box-shadow: 0 18rpx 36rpx rgba(46, 125, 70, 0.2);
}

.cabinet-art__cabinet::before {
  content: "";
  position: absolute;
  inset: 12rpx;
  border-radius: 14rpx;
  border: 3rpx solid rgba(255, 255, 255, 0.42);
}

.cabinet-art__screen {
  position: absolute;
  left: 16rpx;
  top: 18rpx;
  width: 82rpx;
  height: 140rpx;
  border-radius: 10rpx;
  background: #eef8e8;
  overflow: hidden;
}

.cabinet-art__shelf {
  position: absolute;
  left: 8rpx;
  right: 8rpx;
  display: flex;
  justify-content: space-between;
  padding-bottom: 6rpx;
  border-bottom: 3rpx solid rgba(46, 125, 70, 0.2);
}

.cabinet-art__shelf--top {
  top: 18rpx;
}

.cabinet-art__shelf--middle {
  top: 58rpx;
}

.cabinet-art__shelf--bottom {
  top: 98rpx;
}

.cabinet-art__goods {
  width: 16rpx;
  height: 20rpx;
  border-radius: 5rpx;
}

.cabinet-art__goods--green {
  background: #8fcf7f;
}

.cabinet-art__goods--orange {
  background: #ff9a33;
}

.cabinet-art__goods--cream {
  background: #fff0c9;
}

.cabinet-art__panel {
  position: absolute;
  right: 16rpx;
  top: 30rpx;
  width: 28rpx;
  height: 110rpx;
  border-radius: 9rpx;
  background: #f7ffee;
}

.cabinet-art__scan {
  position: absolute;
  left: 6rpx;
  top: 12rpx;
  width: 16rpx;
  height: 16rpx;
  border: 3rpx solid #2e7d46;
  border-radius: 4rpx;
}

.cabinet-art__button {
  position: absolute;
  left: 8rpx;
  bottom: 16rpx;
  width: 12rpx;
  height: 12rpx;
  border-radius: 50%;
  background: #ff8a2b;
}

.cabinet-art__person {
  position: absolute;
  right: 36rpx;
  bottom: 34rpx;
  width: 34rpx;
  height: 72rpx;
}

.cabinet-art__person-head {
  width: 22rpx;
  height: 22rpx;
  margin: 0 auto;
  border-radius: 50%;
  background: #ffbf8a;
}

.cabinet-art__person-body {
  width: 30rpx;
  height: 44rpx;
  margin: 4rpx auto 0;
  border-radius: 14rpx 14rpx 8rpx 8rpx;
  background: #ff8a2b;
}
</style>

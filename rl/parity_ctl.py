# 패리티 시험용 조종 입력 시나리오 (JS와 동일 함수)
def ctl(t):
    if t < 2: return (0.3, 0.0, 0.0, 0.85, False)
    if t < 4: return (0.9, 0.8, 0.0, 0.85, False)
    if t < 6: return (1.0, -0.5, 0.0, 1.0, True)
    if t < 8: return (-0.3, 0.0, 0.2, 0.3, False)
    if t < 10: return (1.0, 0.2, 0.0, 1.0, False)
    return (0.5, -1.0, 0.0, 0.6, True)

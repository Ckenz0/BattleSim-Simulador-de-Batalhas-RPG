import pytest
from worker.runtime import read_cpu_iterations, execute

def test_cpu_load_does_not_change_the_result(task):
    unloaded = execute(task, 0)
    loaded = execute(task, 100)
    assert unloaded[0] == loaded[0]
    assert unloaded[1] >= 0 and loaded[1] >= 0

@pytest.mark.parametrize('value', ['-1','20000001','invalid','1.5'])
def test_invalid_cpu_configuration_fails_fast(value):
    with pytest.raises(ValueError):
        read_cpu_iterations(value)

def test_cpu_configuration_is_bounded():
    assert read_cpu_iterations('0') == 0
    assert read_cpu_iterations('50000') == 50000

"""crosswalk@1: identity registry order, slug stability, collision salting."""

from kayfabe_materializer.merge import CsvNameRegistry
from kayfabe_materializer.normalize import Resolver, fnv1a32


ROWS = [
    (1, "Undertaker"),
    (2, "Kane"),
    (3, "Undertaker & Kane"),
    (4, "Kane & Mystery Partner"),
]


def test_registry_resolves_sqlite_names_first():
    r = Resolver(ROWS)
    reg = CsvNameRegistry(r, {"Undertaker", "Kane", "Mystery Partner", "Jushin Liger"})
    # sqlite individual -> same canonical person (cross-source confirmed)
    assert reg.resolve("Undertaker") == "p:1"
    assert reg.resolve("Kane") == "p:2"
    # sqlite side-derived name -> the SAME derived person, no csv duplicate
    slug = "%08x" % fnv1a32("Mystery Partner")
    assert reg.resolve("Mystery Partner") == f"p:d{slug}"
    # csv-only name -> csv person
    lslug = "%08x" % fnv1a32("Jushin Liger")
    assert reg.resolve("Jushin Liger") == f"p:c{lslug}"
    assert reg.csv_people == {f"p:c{lslug}": "Jushin Liger"}


def test_registry_placeholders_never_become_people():
    r = Resolver(ROWS)
    reg = CsvNameRegistry(r, {"Unknown Wrestler", "Jr.", "TBA", "Real Name"})
    assert reg.resolve("Unknown Wrestler") is None
    assert reg.resolve("Jr.") is None
    assert reg.resolve("TBA") is None
    assert reg.resolve("Real Name") is not None


def test_registry_is_deterministic_and_collision_safe():
    r = Resolver(ROWS)
    names = {f"Wrestler {i}" for i in range(500)}
    a = CsvNameRegistry(r, set(names))
    b = CsvNameRegistry(r, set(names))
    assert a.name_to_cid == b.name_to_cid
    # every csv person id unique
    assert len(set(a.name_to_cid.values())) == len(a.name_to_cid)
